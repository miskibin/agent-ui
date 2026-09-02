import "server-only"

import type { OllamaSettings } from "@/lib/settings/schema"
import { withPromptContext } from "@/lib/providers/system-prefix"
import { LineBuffer } from "@/lib/stream-framing"
import {
  fetchLoadedOllamaModels,
  fetchOllamaContextLengths,
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
        // `/api/chat` takes a `think` level on servers new enough to have one
        // and a plain boolean on the rest; `post` below walks that ladder down,
        // so offering the control costs a model that ignores it nothing.
        effort: true,
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
      const contexts = await fetchOllamaContextLengths(baseUrl, models)
      return models.map((model) => toModelOption(model, contexts[model.id]))
    },

    async visionModels() {
      const models = await fetchOllamaModels(baseUrl)
      return fetchVisionCapableModelIds(baseUrl, models)
    },

    async *run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
      const startedAt = Date.now()
      const messages = [
        // Ollama has a real system role, so the standing memory block goes
        // where it belongs instead of being fenced into the prompt like the
        // CLIs need. The handoff does not: it is about *this* turn, so it
        // rides in front of this turn's prompt.
        ...(options.standingContext?.trim()
          ? [{ role: "system" as const, content: options.standingContext.trim() }]
          : []),
        ...(options.history ?? []).map((turn) => ({
          role: turn.role,
          content: turn.content,
          ...(turn.images?.length ? { images: turn.images } : null),
        })),
        {
          role: "user" as const,
          content: withPromptContext(options.prompt, {
            turnContext: options.turnContext,
          }),
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
        // Three things can be true of a server/model pair and only a 400 tells
        // them apart: it takes a graded `think` level, it takes the boolean, or
        // it has no reasoning head at all. Each rung is tried once, and only
        // when the complaint actually names `think` — an unrelated 400 is the
        // server's own answer and is shown as-is rather than retried blind.
        const ladder = thinkLadder(options.effort)
        res = await post(baseUrl, options.model, messages, ladder[0], options.signal)
        for (let rung = 1; rung < ladder.length && res.status === 400; rung++) {
          const detail = await res.text().catch(() => "")
          if (!/think/i.test(detail)) {
            yield { type: "error", message: detail || "Ollama rejected the request" }
            return
          }
          res = await post(baseUrl, options.model, messages, ladder[rung], options.signal)
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
      const lines = new LineBuffer()
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
          for (const line of lines.push(decoder.decode(value, { stream: true }))) {
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

/**
 * Ollama's `think` levels, which only gpt-oss-style models publish. The app's
 * four-step scale collapses onto the three they accept — there is no budget
 * above `high` to ask for.
 */
const THINK_LEVELS: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
}

/**
 * What to send as `think`, most specific first. A graded level is only worth
 * asking for when the composer actually chose one; everything else starts at
 * the boolean the provider has always sent.
 */
function thinkLadder(effort: string | undefined): Array<string | boolean> {
  const level = THINK_LEVELS[effort?.trim().toLowerCase() ?? ""]
  return level ? [level, true, false] : [true, false]
}

function post(
  baseUrl: string,
  model: string,
  messages: Array<{ role: string; content: string; images?: string[] }>,
  think: string | boolean,
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
