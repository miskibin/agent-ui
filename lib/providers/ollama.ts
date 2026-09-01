import "server-only"

import type { OllamaSettings } from "@/lib/settings/schema"
import {
  fetchOllamaModels,
  fetchVisionCapableModelIds,
  normalizeBaseUrl,
  ollamaReachErrorMessage,
  probeOllama,
  toModelOption,
} from "@/lib/providers/ollama-api"
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  ProviderInfo,
} from "@/lib/providers/types"

export const OLLAMA_PROVIDER_ID = "ollama"

type ChatChunk = {
  message?: { content?: string; thinking?: string }
  done?: boolean
  error?: string
  total_duration?: number
}

/**
 * A direct adapter for a local Ollama server — no CLI, no agent loop, just
 * `/api/chat` with `stream: true`. Ollama is stateless, so the chat route
 * replays the thread through `options.history` on every turn.
 */
export function createOllamaProvider(settings: OllamaSettings): AgentProvider {
  const baseUrl = normalizeBaseUrl(settings.baseUrl)

  return {
    async info(): Promise<ProviderInfo> {
      const capabilities = {
        // No tool protocol here — plain completions with optional thinking.
        tools: false,
        resume: false,
        effort: false,
        // Transport-level: /api/chat always accepts an `images` field. Which
        // *models* actually look at it is a per-model question, answered by
        // `visionModels()` below rather than here.
        vision: true,
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
      const reachable = await probeOllama(baseUrl)
      return reachable
        ? { ...base, available: true }
        : { ...base, unavailableReason: `No server at ${baseUrl}` }
    },

    async listModels() {
      const models = await fetchOllamaModels(baseUrl)
      return models.map(toModelOption)
    },

    async visionModels() {
      const models = await fetchOllamaModels(baseUrl)
      return fetchVisionCapableModelIds(baseUrl, models)
    },

    async *run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
      const startedAt = Date.now()
      const messages = [
        ...(options.history ?? []).map((turn) => ({
          role: turn.role,
          content: turn.content,
          ...(turn.images?.length ? { images: turn.images } : null),
        })),
        {
          role: "user" as const,
          content: options.prompt,
          ...(options.images?.length ? { images: options.images } : null),
        },
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
        yield { type: "error", message: ollamaReachErrorMessage(err, baseUrl) }
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
          yield { type: "error", message: ollamaReachErrorMessage(err, baseUrl) }
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
  messages: Array<{ role: string; content: string; images?: string[] }>,
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
