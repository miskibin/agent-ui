import "server-only"

import type { ModelOption } from "@/components/ui/model-picker"

/**
 * The bits of the Ollama HTTP API shared by the two providers that talk to it:
 * `ollama` (plain chat) and `pi` (the agent harness, which only needs the model
 * list and the reachability probe — the completions themselves go through the
 * pi CLI).
 */

const PROBE_MS = 1_500
/** Availability is probed per request; a short cache keeps pickers snappy. */
const PROBE_CACHE_MS = 10_000

export type OllamaModel = {
  id: string
  name: string
  family?: string
  quantization?: string
  parameterSize?: string
  sizeBytes?: number
}

type TagsResponse = {
  models?: Array<{
    name?: string
    model?: string
    size?: number
    details?: {
      family?: string
      parameter_size?: string
      quantization_level?: string
    }
  }>
}

const probeCache = new Map<string, { at: number; ok: boolean }>()

type ShowResponse = { capabilities?: unknown }

/** Family/name substrings for servers too old to report `/api/show` capabilities. */
const VISION_HINTS = [
  "llava",
  "bakllava",
  "moondream",
  "minicpm-v",
  "qwen2-vl",
  "qwen2.5vl",
  "qwen2.5-vl",
  "pixtral",
  "llama3.2-vision",
  "llama4",
  "gemma3",
  "granite3.2-vision",
  "cogvlm",
]
const VISION_HINT_PATTERN = /(^|[^a-z0-9])(vl|vision)([^a-z0-9]|$)/

/** Cheap fallback when `/api/show` doesn't report capabilities: family/name hints. */
export function looksVisionCapable(model: OllamaModel) {
  const haystack = `${model.family ?? ""} ${model.id}`.toLowerCase()
  return (
    VISION_HINTS.some((hint) => haystack.includes(hint)) ||
    VISION_HINT_PATTERN.test(haystack)
  )
}

const SHOW_MS = 2_000

/** Authoritative per-model capability list; `null` when the call fails. */
async function fetchModelCapabilities(
  baseUrl: string,
  model: string
): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      cache: "no-store",
      signal: AbortSignal.timeout(SHOW_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as ShowResponse
    return Array.isArray(data.capabilities)
      ? data.capabilities.filter((c): c is string => typeof c === "string")
      : null
  } catch {
    return null
  }
}

/**
 * Which of these models take image input. `/api/show` is authoritative on
 * Ollama servers new enough to report `capabilities`; older servers fall
 * back to a family/name heuristic. Probed in parallel and best-effort — a
 * slow or failing model just drops out of the list rather than failing the
 * whole page.
 */
export async function fetchVisionCapableModelIds(
  baseUrl: string,
  models: OllamaModel[]
): Promise<string[]> {
  const checks = await Promise.all(
    models.map(async (model) => {
      const capabilities = await fetchModelCapabilities(baseUrl, model.id)
      const vision = capabilities
        ? capabilities.includes("vision")
        : looksVisionCapable(model)
      return vision ? model.id : null
    })
  )
  return checks.filter((id): id is string => id !== null)
}

/** Trailing slashes make every joined path double up — strip them once here. */
export function normalizeBaseUrl(raw: string) {
  return raw.trim().replace(/\/+$/, "")
}

/** Never throws — an unreachable server is a UI state, not an error. */
export async function probeOllama(baseUrl: string) {
  const cached = probeCache.get(baseUrl)
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.ok
  let ok = false
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_MS),
    })
    ok = res.ok
  } catch {
    ok = false
  }
  probeCache.set(baseUrl, { at: Date.now(), ok })
  return ok
}

export async function fetchOllamaModels(
  baseUrl: string
): Promise<OllamaModel[]> {
  const res = await fetch(`${baseUrl}/api/tags`, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`Ollama /api/tags failed (${res.status})`)
  const data = (await res.json()) as TagsResponse
  return (data.models ?? [])
    .map((entry): OllamaModel | null => {
      const id = entry.model || entry.name
      if (!id) return null
      return {
        id,
        name: entry.name ?? id,
        family: entry.details?.family,
        quantization: entry.details?.quantization_level,
        parameterSize: entry.details?.parameter_size,
        sizeBytes: entry.size,
      }
    })
    .filter((model): model is OllamaModel => model !== null)
}

/**
 * Models Ollama currently holds in memory (`/api/ps`).
 *
 * This is what separates "the model is thinking" from "the model is still
 * being read off disk": a cold 8B model can take a minute before it emits a
 * single token, and that minute is worth naming. Never throws — an unanswered
 * probe just means we cannot promise either way.
 */
export async function fetchLoadedOllamaModels(
  baseUrl: string
): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/ps`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_MS),
    })
    if (!res.ok) return []
    const data = (await res.json()) as TagsResponse
    return (data.models ?? [])
      .map((entry) => entry.model || entry.name)
      .filter((id): id is string => !!id)
  } catch {
    return []
  }
}

export function toModelOption(model: OllamaModel): ModelOption {
  return {
    id: model.id,
    name: model.name,
    badge: model.family,
    description: model.quantization,
    meta: [model.parameterSize, formatSize(model.sizeBytes)]
      .filter(Boolean)
      .join(" · "),
  }
}

export function ollamaReachErrorMessage(err: unknown, baseUrl: string) {
  const message = err instanceof Error ? err.message : String(err)
  return /fetch failed|ECONNREFUSED/i.test(message)
    ? `Could not reach Ollama at ${baseUrl}`
    : message
}

function formatSize(bytes?: number) {
  if (!bytes || bytes <= 0) return undefined
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}
