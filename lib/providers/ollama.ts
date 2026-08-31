import "server-only"

import type { ModelOption } from "@/components/ui/model-picker"
import type { OllamaSettings } from "@/lib/settings/schema"
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  ProviderInfo,
} from "@/lib/providers/types"

export const OLLAMA_PROVIDER_ID = "ollama"

const PROBE_MS = 1_500
/** Availability is probed per request; a short cache keeps pickers snappy. */
const PROBE_CACHE_MS = 10_000

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

type ChatChunk = {
  message?: { content?: string; thinking?: string }
  done?: boolean
  error?: string
  total_duration?: number
}

const probeCache = new Map<string, { at: number; ok: boolean }>()

/**
 * A direct adapter for a local Ollama server — no CLI, no agent loop, just
 * `/api/chat` with `stream: true`. Ollama is stateless, so the chat route
 * replays the thread through `options.history` on every turn.
 */
export function createOllamaProvider(settings: OllamaSettings): AgentProvider {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, "")

  return {
    async info(): Promise<ProviderInfo> {
      const capabilities = {
        // No tool protocol here — plain completions with optional thinking.
        tools: false,
        resume: false,
        effort: false,
        vision: false,
      }
      const base: ProviderInfo = {
        id: OLLAMA_PROVIDER_ID,
        name: "Ollama",
        description: `Local models served from ${baseUrl || "an unset URL"}.`,
        capabilities,
        available: false,
      }
      if (!settings.enabled) {
        return { ...base, unavailableReason: "Disabled in settings" }
      }
      if (!baseUrl) return { ...base, unavailableReason: "No base URL set" }
      const reachable = await probe(baseUrl)
      return reachable
        ? { ...base, available: true }
        : { ...base, unavailableReason: `No server at ${baseUrl}` }
    },

    async listModels() {
      const res = await fetch(`${baseUrl}/api/tags`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) throw new Error(`Ollama /api/tags failed (${res.status})`)
      const data = (await res.json()) as TagsResponse
      return (data.models ?? [])
        .map((entry): ModelOption | null => {
          const id = entry.model || entry.name
          if (!id) return null
          return {
            id,
            name: entry.name ?? id,
            badge: entry.details?.family,
            description: entry.details?.quantization_level,
            meta: [entry.details?.parameter_size, formatSize(entry.size)]
              .filter(Boolean)
              .join(" · "),
          }
        })
        .filter((model): model is ModelOption => model !== null)
    },

    async *run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
      const startedAt = Date.now()
      const messages = [
        ...(options.history ?? []).map((turn) => ({
          role: turn.role,
          content: turn.content,
        })),
        { role: "user" as const, content: options.prompt },
      ]

      let res: Response
      try {
        res = await post(baseUrl, options.model, messages, true, options.signal)
        // Models without a reasoning head reject `think`; retry plainly.
        if (res.status === 400) {
          const detail = await res.text().catch(() => "")
          if (/think/i.test(detail)) {
            res = await post(
              baseUrl,
              options.model,
              messages,
              false,
              options.signal
            )
          } else {
            yield { type: "error", message: detail || "Ollama rejected the request" }
            return
          }
        }
      } catch (err) {
        if (options.signal.aborted) return
        yield { type: "error", message: reachErrorMessage(err, baseUrl) }
        return
      }

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "")
        yield {
          type: "error",
          message: detail.trim() || `Ollama request failed (${res.status})`,
        }
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let done = false

      try {
        while (!done) {
          const { done: streamDone, value } = await reader.read()
          if (streamDone) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            let chunk: ChatChunk
            try {
              chunk = JSON.parse(trimmed) as ChatChunk
            } catch {
              continue
            }
            if (chunk.error) {
              yield { type: "error", message: chunk.error }
              return
            }
            if (chunk.message?.thinking) {
              yield { type: "thinking", text: chunk.message.thinking }
            }
            if (chunk.message?.content) {
              yield { type: "text", text: chunk.message.content }
            }
            if (chunk.done) {
              done = true
              yield {
                type: "done",
                durationMs:
                  typeof chunk.total_duration === "number"
                    ? Math.round(chunk.total_duration / 1e6)
                    : Date.now() - startedAt,
              }
              break
            }
          }
        }
      } catch (err) {
        if (!options.signal.aborted) {
          yield { type: "error", message: reachErrorMessage(err, baseUrl) }
        }
      } finally {
        await reader.cancel().catch(() => {})
      }

      if (!done && !options.signal.aborted) {
        yield { type: "done", durationMs: Date.now() - startedAt }
      }
    },
  }
}

function post(
  baseUrl: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  think: boolean,
  signal: AbortSignal
) {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true, think }),
    signal,
    cache: "no-store",
  })
}

/** Never throws — an unreachable server is a UI state, not an error. */
async function probe(baseUrl: string) {
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

function reachErrorMessage(err: unknown, baseUrl: string) {
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
