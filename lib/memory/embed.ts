import "server-only"

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { memoryDir } from "@/lib/memory/server"
import {
  documentInput,
  queryInput,
  toUnitVector,
  type MemoryFact,
} from "@/lib/memory/retrieve"

/**
 * EmbeddingGemma through the user's own Ollama, plus the cache that keeps the
 * store from being re-embedded on every turn.
 *
 * The cache is `memory/.vectors.json`: one vector per fact, keyed by the
 * fact's normalized text rather than by file and line. The markdown files stay
 * the store — the user edits them by hand — and a key derived from the text is
 * what survives that: an edited line misses and is embedded once, an untouched
 * one is never embedded again, a deleted one is pruned on the next write. The
 * dot prefix keeps it out of `readMemoryFiles`, and `clearMemory` takes it
 * with the directory.
 */

/**
 * Matryoshka cut — see `toUnitVector`. Asked of Ollama directly (`dimensions`)
 * so the full 768 floats never cross the wire; the client-side cut stays as
 * the backstop for a server too old to honour the field, which ignores it.
 * 256 rather than 128: at a few hundred one-line facts the cache is small
 * either way, and the duplicate threshold wants the sharper similarities.
 */
const DIMS = 256
/** Ollama takes a batch per request; this keeps one request well under a second on CPU. */
const BATCH = 32
/** Keeps the model resident between turns, so a query embeds in tens of ms instead of a cold load. */
const KEEP_ALIVE = "30m"
/** A cold first load is the slow case; past this a turn goes ahead with lexical ranking. */
const EMBED_TIMEOUT_MS = 8_000
/** A model that failed to run is not retried on every turn. */
const FAILURE_COOLDOWN_MS = 10 * 60_000
/** A pull is a few hundred MB; it gets its own, generous clock. */
const PULL_TIMEOUT_MS = 30 * 60_000

export type EmbedState = "ready" | "pulling" | "missing" | "failed" | "unknown"

export class EmbedError extends Error {
  readonly reason: "missing-model" | "failed"
  constructor(message: string, reason: "missing-model" | "failed") {
    super(message)
    this.reason = reason
  }
}

type VectorCache = { model: string; dims: number; vectors: Record<string, string> }

/**
 * Per-process state on `globalThis`, the same way `ollama-autostart` keeps its
 * own: a dev recompile must not forget that a pull is already running.
 */
const state = ((globalThis as {
  __agentUiMemoryEmbed?: {
    pulls: Map<string, Promise<boolean>>
    failures: Map<string, { at: number; message: string }>
    ready: Set<string>
  }
}).__agentUiMemoryEmbed ??= {
  pulls: new Map(),
  failures: new Map(),
  ready: new Set(),
})

function cachePath() {
  return join(memoryDir(), ".vectors.json")
}

function encode(vector: Float32Array) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString(
    "base64"
  )
}

function decode(raw: string) {
  // Copied out of the Buffer: a small one lives in Node's shared pool at an
  // offset a Float32Array view may not start at.
  return new Float32Array(new Uint8Array(Buffer.from(raw, "base64")).buffer)
}

async function readCache(model: string): Promise<VectorCache> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), "utf8")) as VectorCache
    // Another model's vectors live in another space — comparing across is noise.
    if (parsed.model === model && parsed.dims === DIMS && parsed.vectors) {
      return parsed
    }
  } catch {
    /* no cache yet, or a corrupt one: start over */
  }
  return { model, dims: DIMS, vectors: {} }
}

async function writeCache(cache: VectorCache) {
  await mkdir(memoryDir(), { recursive: true })
  const path = cachePath()
  const tmp = `${path}.${process.pid.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(cache), "utf8")
  await rename(tmp, path)
}

/** What the settings page and the boot check show for the embedding model. */
export function embedState(model: string): EmbedState {
  if (state.pulls.has(model)) return "pulling"
  const failure = state.failures.get(model)
  if (failure && Date.now() - failure.at < FAILURE_COOLDOWN_MS) {
    return failure.message.includes("not found") ? "missing" : "failed"
  }
  return state.ready.has(model) ? "ready" : "unknown"
}

export function embedFailure(model: string) {
  return state.failures.get(model)?.message
}

/**
 * Starts `ollama pull` for the model, once per process. Not awaited by
 * anything on a turn's path — a few hundred megabytes is minutes on a slow
 * line, and memory ranks lexically until it lands.
 */
export function pullEmbedModel(baseUrl: string, model: string) {
  const existing = state.pulls.get(model)
  if (existing) return existing
  const pending = (async () => {
    try {
      const res = await fetch(`${baseUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: false }),
        signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
      })
      const body = (await res.json().catch(() => ({}))) as {
        status?: string
        error?: string
      }
      if (!res.ok || body.error) {
        state.failures.set(model, {
          at: Date.now(),
          message: body.error ?? `ollama pull failed (${res.status})`,
        })
        return false
      }
      state.failures.delete(model)
      return true
    } catch (err) {
      state.failures.set(model, {
        at: Date.now(),
        message: err instanceof Error ? err.message : "ollama pull failed",
      })
      return false
    } finally {
      state.pulls.delete(model)
    }
  })()
  state.pulls.set(model, pending)
  return pending
}

/**
 * One `/api/embed` round trip per batch. A missing model starts its pull and
 * throws `missing-model`; any other failure — including a build of Ollama that
 * cannot run this model on this hardware — is remembered for a cooldown so a
 * broken embedder costs one slow request, not one per turn.
 */
async function embedRaw(
  baseUrl: string,
  model: string,
  inputs: string[],
  signal?: AbortSignal
): Promise<Float32Array[]> {
  const failure = state.failures.get(model)
  if (state.pulls.has(model)) {
    throw new EmbedError(`${model} is still downloading`, "missing-model")
  }
  if (failure && Date.now() - failure.at < FAILURE_COOLDOWN_MS) {
    throw new EmbedError(
      failure.message,
      failure.message.includes("not found") ? "missing-model" : "failed"
    )
  }

  const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS)
  const out: Float32Array[] = []
  for (let start = 0; start < inputs.length; start += BATCH) {
    const res = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: inputs.slice(start, start + BATCH),
        truncate: true,
        dimensions: DIMS,
        keep_alive: KEEP_ALIVE,
      }),
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const body = (await res.json().catch(() => ({}))) as {
      embeddings?: number[][]
      error?: string
    }
    if (!res.ok || !Array.isArray(body.embeddings)) {
      const message = body.error ?? `Ollama /api/embed failed (${res.status})`
      state.failures.set(model, { at: Date.now(), message })
      if (res.status === 404 || /not found/i.test(message)) {
        void pullEmbedModel(baseUrl, model)
        throw new EmbedError(message, "missing-model")
      }
      throw new EmbedError(message, "failed")
    }
    for (const embedding of body.embeddings) out.push(toUnitVector(embedding, DIMS))
  }
  state.ready.add(model)
  state.failures.delete(model)
  return out
}

export async function embedQuery(
  baseUrl: string,
  model: string,
  text: string,
  signal?: AbortSignal
) {
  const [vector] = await embedRaw(baseUrl, model, [queryInput(text)], signal)
  return vector
}

export function embedDocuments(
  baseUrl: string,
  model: string,
  texts: string[],
  signal?: AbortSignal
) {
  return embedRaw(baseUrl, model, texts.map(documentInput), signal)
}

/**
 * A vector for every fact, embedding only the ones the cache has not seen and
 * pruning the ones that no longer exist. The cache is rewritten only when it
 * changed, so a turn over an unchanged store reads one file and writes none.
 */
export async function factVectors(
  baseUrl: string,
  model: string,
  facts: MemoryFact[],
  signal?: AbortSignal
): Promise<Map<string, Float32Array>> {
  const cache = await readCache(model)
  const missing = facts.filter((fact) => !cache.vectors[fact.key])
  let dirty = false
  if (missing.length > 0) {
    const vectors = await embedDocuments(
      baseUrl,
      model,
      missing.map((fact) => fact.text),
      signal
    )
    missing.forEach((fact, index) => {
      cache.vectors[fact.key] = encode(vectors[index])
    })
    dirty = true
  }
  const live = new Set(facts.map((fact) => fact.key))
  for (const key of Object.keys(cache.vectors)) {
    if (!live.has(key)) {
      delete cache.vectors[key]
      dirty = true
    }
  }
  if (dirty) await writeCache(cache).catch(() => undefined)

  const out = new Map<string, Float32Array>()
  for (const fact of facts) {
    const raw = cache.vectors[fact.key]
    if (raw) out.set(fact.key, decode(raw))
  }
  return out
}
