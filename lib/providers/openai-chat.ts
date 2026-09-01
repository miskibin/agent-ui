import "server-only"

import type { ModelOption } from "@/components/ui/model-picker"
import { joinModelId, splitModelId } from "@/lib/model-providers/ids"
import {
  enabledModelSources,
  listSourceModels,
  type ModelSource,
} from "@/lib/model-providers/server"
import { LineBuffer } from "@/lib/stream-framing"
import type { AppSettings } from "@/lib/settings/schema"
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  ProviderInfo,
} from "@/lib/providers/types"

export const OPENAI_CHAT_PROVIDER_ID = "chat"

/** One `data: {…}` frame of an OpenAI-compatible completion stream. */
type ChatChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null
      /** DeepSeek / xAI spell visible reasoning this way. */
      reasoning_content?: string | null
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
  error?: { message?: string } | string
}

/** How much of a failing response body is worth putting in front of the user. */
const ERROR_EXCERPT = 400

/**
 * Plain chat against the configured OpenAI-compatible model providers — no
 * tools, no agent loop, just `/chat/completions` with `stream: true`.
 *
 * The `ollama` provider already covers the local server, so this one lists
 * only the hosted sources from `settings.modelProviders`. Like Ollama it is
 * stateless: the chat route replays the thread through `options.history`.
 */
export function createOpenAiChatProvider(settings: AppSettings): AgentProvider {
  const sources = enabledModelSources(settings)
  const bySlug = new Map(sources.map((source) => [source.slug, source]))

  return {
    async info(): Promise<ProviderInfo> {
      const base: ProviderInfo = {
        id: OPENAI_CHAT_PROVIDER_ID,
        name: "Chat (direct)",
        description:
          "Direct chat with your configured model providers — no tools.",
        capabilities: {
          tools: false,
          resume: false,
          effort: false,
          vision: false,
        },
        available: sources.length > 0,
      }
      return base.available
        ? base
        : {
            ...base,
            unavailableReason:
              "No model providers configured — add one in Settings → Model providers.",
          }
    },

    async listModels(): Promise<ModelOption[]> {
      const listed = await Promise.all(
        sources.map(async (source) => ({
          source,
          // One unreachable endpoint must not empty the whole picker.
          models: await listSourceModels(source).catch(() => []),
        }))
      )
      return listed.flatMap(({ source, models }) =>
        models.map((model) => ({
          id: joinModelId(source.slug, model.id),
          name: model.name,
          group: source.slug,
        }))
      )
    },

    async listModelGroups() {
      return sources.map((source) => ({ id: source.slug, label: source.name }))
    },

    async *run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
      const startedAt = Date.now()
      const { source: slug, model } = splitModelId(options.model)
      const source = bySlug.get(slug)
      if (!source) {
        yield {
          type: "error",
          message: `No enabled model provider named "${slug}" — check Settings → Model providers.`,
        }
        return
      }

      const messages = [
        ...(options.system?.trim()
          ? [{ role: "system" as const, content: options.system.trim() }]
          : []),
        ...(options.history ?? []).map((turn) => ({
          role: turn.role,
          content: turn.content,
        })),
        { role: "user" as const, content: options.prompt },
      ]

      yield {
        type: "status",
        stage: "connecting",
        text: `Reaching ${source.name}`,
      }

      let res: Response
      try {
        res = await post(source, model, messages, true, options.signal)
        // Not every compat server knows `stream_options`, and the ones that do
        // not reject the whole request rather than ignoring it — so a 400 is
        // worth one more attempt, giving up the usage report instead of the
        // turn. A 400 that meant something else fails again, and it is that
        // second answer the user is shown.
        if (res.status === 400) {
          const detail = await res.text().catch(() => "")
          const retry = await post(source, model, messages, false, options.signal)
          if (!retry.ok) {
            const retryDetail = await retry.text().catch(() => "")
            yield {
              type: "error",
              message: failureMessage(source, retry.status, retryDetail || detail),
            }
            return
          }
          res = retry
        }
      } catch (err) {
        if (options.signal.aborted) return
        yield { type: "error", message: reachErrorMessage(err, source) }
        return
      }

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "")
        yield { type: "error", message: failureMessage(source, res.status, detail) }
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const lines = new LineBuffer()
      let usage: { input?: number; output?: number } | undefined
      let closed = false

      try {
        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          for (const line of lines.push(decoder.decode(value, { stream: true }))) {
            const trimmed = line.trim()
            // Blank lines separate SSE events; comments start with a colon.
            if (!trimmed || trimmed.startsWith(":")) continue
            if (!trimmed.startsWith("data:")) continue
            const payload = trimmed.slice(5).trim()
            if (payload === "[DONE]") {
              closed = true
              break
            }
            let chunk: ChatChunk
            try {
              chunk = JSON.parse(payload) as ChatChunk
            } catch {
              continue
            }
            const error = errorText(chunk)
            if (error) {
              yield { type: "error", message: error }
              return
            }
            // The usage frame arrives last and carries no choices.
            if (chunk.usage) {
              usage = {
                input: chunk.usage.prompt_tokens,
                output: chunk.usage.completion_tokens,
              }
            }
            const delta = chunk.choices?.[0]?.delta
            if (delta?.reasoning_content) {
              yield { type: "thinking", text: delta.reasoning_content }
            }
            if (delta?.content) {
              yield { type: "text", text: delta.content }
            }
          }
        }
      } catch (err) {
        if (!options.signal.aborted) {
          yield { type: "error", message: reachErrorMessage(err, source) }
          return
        }
      } finally {
        await reader.cancel().catch(() => {})
      }

      if (options.signal.aborted) return
      const durationMs = Date.now() - startedAt
      yield {
        type: "done",
        durationMs,
        usage: usage
          ? {
              ...usage,
              tokensPerSecond:
                usage.output != null && durationMs > 0
                  ? usage.output / (durationMs / 1000)
                  : undefined,
            }
          : undefined,
      }
    },
  }
}

function post(
  source: ModelSource,
  model: string,
  messages: Array<{ role: string; content: string }>,
  streamOptions: boolean,
  signal: AbortSignal
) {
  return fetch(`${source.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(source.apiKey ? { Authorization: `Bearer ${source.apiKey}` } : null),
    },
    body: JSON.stringify({
      model,
      stream: true,
      ...(streamOptions ? { stream_options: { include_usage: true } } : null),
      messages,
    }),
    signal,
    cache: "no-store",
  })
}

/** An error the endpoint reported inside the stream rather than as a status. */
function errorText(chunk: ChatChunk) {
  if (!chunk.error) return null
  if (typeof chunk.error === "string") return chunk.error
  return chunk.error.message || "The model provider reported an error"
}

function failureMessage(source: ModelSource, status: number, body: string) {
  const excerpt = body.trim().slice(0, ERROR_EXCERPT)
  const prefix =
    status === 401 || status === 403
      ? `${source.name} rejected the API key (${status})`
      : `${source.name} request failed (${status})`
  return excerpt ? `${prefix}: ${excerpt}` : prefix
}

function reachErrorMessage(err: unknown, source: ModelSource) {
  const message = err instanceof Error ? err.message : String(err)
  return /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)
    ? `Could not reach ${source.name} at ${source.baseUrl}`
    : message
}
