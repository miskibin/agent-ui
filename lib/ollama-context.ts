/**
 * The three context-window numbers an Ollama model carries, and which one
 * actually predicts the 400 a long request gets back.
 *
 * `/api/show`'s `model_info.*.context_length` is the architecture's maximum —
 * 262144 on a 256k tag. Ollama does not serve that. It picks the window at
 * load time, and unless the Modelfile (or a request) asked for something else
 * the default is 4096, which is why the composer can read "2.4% of 256k"
 * while the server refuses an 18k prompt. Pure, and free of `node:`, so the
 * tests can pin the parsing without a server.
 */

/** What Ollama serves when nobody asked for a window. */
export const OLLAMA_DEFAULT_NUM_CTX = 4_096

/** `/api/show` fields that name a configured `num_ctx`. */
export type OllamaShowContext = {
  parameters?: unknown
  modelfile?: string
}

/**
 * The architecture's maximum, off `model_info`. Keys are prefixed with a
 * family we cannot know ahead of time (`qwen35.context_length`).
 *
 * A ceiling for callers that *can* ask for a bigger window (`lib/completion.ts`
 * over the native `/api/chat`). Not what the runtime is serving.
 */
export function architectureContextLength(
  info: Record<string, unknown> | undefined
): number | undefined {
  if (!info) return undefined
  for (const [key, value] of Object.entries(info)) {
    if (!key.endsWith(".context_length")) continue
    const parsed = positiveInt(value)
    if (parsed) return parsed
  }
  return undefined
}

/**
 * `num_ctx` from the model's own config — the Modelfile / `parameters` blob
 * `/api/show` returns — or undefined when the file never set one, which is
 * the usual case and the one that falls through to Ollama's 4096 default.
 */
export function configuredOllamaNumCtx(
  show: OllamaShowContext
): number | undefined {
  return numCtxFromParameters(show.parameters) ?? numCtxFromModelfile(show.modelfile)
}

/**
 * The window the next request will actually be served with.
 *
 * `/api/ps` wins when the model is already loaded — that is the KV cache in
 * memory, and a later request cannot grow it without a reload. Otherwise the
 * Modelfile, otherwise the default. Never the architecture's maximum: that is
 * the number that put 256k under a 4k model.
 */
export function servedOllamaContext(opts: {
  running?: number
  configured?: number
}): number {
  return (
    positiveInt(opts.running) ??
    positiveInt(opts.configured) ??
    OLLAMA_DEFAULT_NUM_CTX
  )
}

/**
 * How many tokens of *output* still fit once the window is known. pi defaults
 * to 16384, which does not fit a 4k Ollama, so the catalog has to name one.
 */
export function ollamaOutputBudget(contextWindow: number): number {
  const window = positiveInt(contextWindow) ?? OLLAMA_DEFAULT_NUM_CTX
  return Math.max(256, Math.min(16_384, Math.floor(window / 4)))
}

function numCtxFromParameters(parameters: unknown): number | undefined {
  if (parameters == null) return undefined
  if (typeof parameters === "object" && !Array.isArray(parameters)) {
    const record = parameters as Record<string, unknown>
    return positiveInt(record.num_ctx ?? record.numCtx)
  }
  if (typeof parameters !== "string") return undefined
  for (const line of parameters.split(/\r?\n/)) {
    const match = /^\s*num_ctx\s+(\d+)\s*$/i.exec(line)
    if (match) return positiveInt(Number(match[1]))
  }
  return undefined
}

function numCtxFromModelfile(modelfile: string | undefined): number | undefined {
  if (!modelfile) return undefined
  const match = /^\s*PARAMETER\s+num_ctx\s+(\d+)\s*$/im.exec(modelfile)
  return match ? positiveInt(Number(match[1])) : undefined
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(n) || n <= 0) return undefined
  return n
}
