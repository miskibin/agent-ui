import "server-only"

import type { OllamaSettings } from "@/lib/settings/schema"
import {
  fetchLoadedOllamaModels,
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
  prompt_eval_count?: number
  eval_count?: number
  /** Nanoseconds spent generating, which is what makes tok/s meaningful. */
  eval_duration?: number
}

/**
 * How often the run says something while nothing has arrived yet. Long enough
 * not to be chatter, short enough that the line is visibly counting rather
 * than stuck.
 */
const WAIT_TICK_MS = 4_000

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

      /**
       * The first turn against a cold model is the one that feels broken: the
       * server answers the request immediately and then says nothing at all
       * for as long as it takes to read the weights off disk. `/api/ps` is
       * the only thing that can tell that apart from a model that is simply
       * slow, so it is asked before the request goes out — and what it says
       * decides the wording for the whole wait below.
       */
      yield { type: "status", stage: "connecting", text: "Reaching Ollama" }
      const loaded = await fetchLoadedOllamaModels(baseUrl)
      if (options.signal.aborted) return
      const cold = loaded.length > 0 && !loaded.includes(options.model)
      const waitingText = cold
        ? `Loading ${options.model} into memory — the first turn is the slow one`
        : `Waiting for ${options.model}'s first token`
      yield {
        type: "status",
        stage: cold ? "loading" : "thinking",
        text: waitingText,
      }

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
      /** Nothing has been shown yet, so the wait is still worth narrating. */
      let silent = true
      /**
       * `reader.read()` may only be awaited once per call, so the pending
       * promise is held across ticks and re-raced rather than re-issued.
       */
      let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null

      try {
        while (!done) {
          pending ??= reader.read()
          const next: Waited = silent
            ? await Promise.race<Waited>([
                pending.then((chunk) => ({ chunk })),
                tick(WAIT_TICK_MS, options.signal),
              ])
            : { chunk: await pending }

          if (!next.chunk) {
            yield {
              type: "status",
              stage: cold ? "loading" : "thinking",
              text: `${waitingText} · ${Math.round((Date.now() - startedAt) / 1000)}s`,
            }
            continue
          }

          pending = null
          const { done: streamDone, value } = next.chunk
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
              silent = false
              yield { type: "thinking", text: chunk.message.thinking }
            }
            if (chunk.message?.content) {
              silent = false
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
                usage: usageFrom(chunk),
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

/** Either the read landed, or the wait ticked over — see the loop above. */
type Waited =
  | { chunk: ReadableStreamReadResult<Uint8Array> }
  | { chunk?: undefined }

/**
 * Resolves after `ms` — or as soon as the run is abandoned, so a cancelled
 * turn does not hold a timer open until it fires.
 */
function tick(ms: number, signal: AbortSignal): Promise<{ chunk?: undefined }> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve({})
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

/** Ollama's own counters, when the final chunk carries them. */
function usageFrom(chunk: ChatChunk) {
  const output = chunk.eval_count
  const seconds = chunk.eval_duration ? chunk.eval_duration / 1e9 : 0
  if (chunk.prompt_eval_count == null && output == null) return undefined
  return {
    input: chunk.prompt_eval_count,
    output,
    tokensPerSecond: output != null && seconds > 0 ? output / seconds : undefined,
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
