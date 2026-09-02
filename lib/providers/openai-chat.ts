import "server-only"

import type { ModelOption } from "@/components/ui/model-picker"
import { joinModelId, splitModelId } from "@/lib/model-providers/ids"
import {
  enabledModelSources,
  listSourceModels,
  type ModelSource,
} from "@/lib/model-providers/server"
import { withPromptContext } from "@/lib/providers/system-prefix"
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
      /**
       * Nothing here declares tools, but a model trained to reach for them
       * answers with one anyway — see `emptyTurnMessage`.
       */
      tool_calls?: unknown[] | null
    }
    finish_reason?: string | null
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
          // `reasoning_effort` is the OpenAI-compatible spelling; an endpoint
          // that does not know it says so on the first request and the retry
          // below drops it, so offering the control costs nothing.
          effort: true,
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
        ...(options.standingContext?.trim()
          ? [
              {
                role: "system" as const,
                content: options.standingContext.trim(),
              },
            ]
          : []),
        ...(options.history ?? []).map((turn) => ({
          role: turn.role,
          content: turn.content,
        })),
        {
          role: "user" as const,
          content: withPromptContext(options.prompt, {
            turnContext: options.turnContext,
          }),
        },
      ]

      yield {
        type: "status",
        stage: "connecting",
        text: `Reaching ${source.name}`,
      }

      let res: Response
      try {
        const body: RequestFields = {
          streamOptions: true,
          reasoningEffort: reasoningEffort(options.effort),
        }
        res = await post(source, model, messages, body, options.signal)
        // Not every compat server knows `stream_options` or `reasoning_effort`,
        // and the ones that do not reject the whole request rather than
        // ignoring it — so when the complaint names one, that field is what
        // gets given up rather than the turn. At most one retry per field: a
        // 400 nobody can attribute is the endpoint's own answer and is shown
        // as-is instead of being sent again.
        for (let attempt = 0; attempt < 2 && res.status === 400; attempt++) {
          const detail = await res.text().catch(() => "")
          const dropped = dropOffendingField(body, detail)
          if (!dropped) {
            yield { type: "error", message: failureMessage(source, 400, detail) }
            return
          }
          res = await post(source, model, messages, body, options.signal)
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
      // A turn that streams reasoning and then stops without a word of
      // content is silent in the UI, so the end of the stream checks for it.
      let sawText = false
      let toolAttempt = false

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
            const choice = chunk.choices?.[0]
            if (choice?.finish_reason === "tool_calls") toolAttempt = true
            const delta = choice?.delta
            if (delta?.tool_calls?.length) toolAttempt = true
            if (delta?.reasoning_content) {
              yield { type: "thinking", text: delta.reasoning_content }
            }
            if (delta?.content) {
              sawText = true
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
      if (!sawText) {
        yield { type: "error", message: emptyTurnMessage(source, toolAttempt) }
        return
      }
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

/** The optional request fields a picky endpoint may make us give up. */
type RequestFields = {
  streamOptions: boolean
  reasoningEffort?: string
}

function post(
  source: ModelSource,
  model: string,
  messages: Array<{ role: string; content: string }>,
  fields: RequestFields,
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
      ...(fields.streamOptions
        ? { stream_options: { include_usage: true } }
        : null),
      ...(fields.reasoningEffort
        ? { reasoning_effort: fields.reasoningEffort }
        : null),
      messages,
    }),
    signal,
    cache: "no-store",
  })
}

/**
 * The app's effort scale in OpenAI's vocabulary: it accepts `low | medium |
 * high`, so the picker's `xhigh` lands on `high` rather than being rejected.
 */
function reasoningEffort(effort: string | undefined): string | undefined {
  const value = effort?.trim().toLowerCase()
  if (!value) return undefined
  return value === "xhigh" ? "high" : value
}

/**
 * Reads a 400 and turns off whichever optional field it blames, returning
 * whether anything changed (i.e. whether a retry is worth making).
 *
 * A complaint that names a field wins over a vague "unknown parameter", so a
 * server grumbling about `stream_options` never costs the turn its effort
 * setting as well.
 */
function dropOffendingField(fields: RequestFields, detail: string): boolean {
  const namesStream = /stream_options/i.test(detail)
  const namesEffort = /reasoning_effort/i.test(detail)
  const vague = /unknown|unsupported/i.test(detail)

  if (fields.streamOptions && namesStream) {
    fields.streamOptions = false
    return true
  }
  if (fields.reasoningEffort && (namesEffort || (vague && !namesStream))) {
    fields.reasoningEffort = undefined
    return true
  }
  return false
}

/**
 * What to say when a turn ends having streamed reasoning but no content.
 *
 * Models tuned for agent harnesses answer some prompts with a tool call even
 * when the request declares no tools — DeepSeek then drops the call it parsed
 * and the turn arrives empty. Without this the user sees a thinking block and
 * nothing else, which reads as a broken app rather than a wrong backend.
 */
function emptyTurnMessage(source: ModelSource, toolAttempt: boolean) {
  return toolAttempt
    ? `The model tried to call a tool, and Chat (direct) has no tools — pick a harness that does (pi, or an ACP agent) for this prompt.`
    : `${source.name} returned an empty response — the model produced reasoning but no answer. Try again, or rephrase the prompt.`
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
