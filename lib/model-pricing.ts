/**
 * Rough list prices, in US dollars per million tokens, for the hosted models
 * the built-in providers serve. Used only to put a "$0.012" next to a turn's
 * token counts — an estimate, and labelled as one: caching discounts, batch
 * rates and price changes are not tracked here.
 *
 * Keyed by the bare model id, matched by longest prefix, so a dated snapshot
 * (`gpt-4o-2024-11-20`) picks up its family's price. Local models (Ollama)
 * cost nothing and are answered as such rather than as "unknown".
 *
 * Client-safe: no imports, just a table and a lookup.
 */

export type ModelPrice = {
  /** $ per 1M input tokens. */
  input: number
  /** $ per 1M output tokens. */
  output: number
}

const ANTHROPIC: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5-1": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
}

const OPENAI: Record<string, ModelPrice> = {
  "gpt-5.1": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o3": { input: 2, output: 8 },
  "o1": { input: 15, output: 60 },
}

const GOOGLE: Record<string, ModelPrice> = {
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
}

const XAI: Record<string, ModelPrice> = {
  "grok-4-fast": { input: 0.2, output: 0.5 },
  "grok-4": { input: 3, output: 15 },
  "grok-3-mini": { input: 0.3, output: 0.5 },
  "grok-3": { input: 3, output: 15 },
}

const DEEPSEEK: Record<string, ModelPrice> = {
  "deepseek-chat": { input: 0.28, output: 0.42 },
  "deepseek-reasoner": { input: 0.28, output: 0.42 },
}

const MISTRAL: Record<string, ModelPrice> = {
  "mistral-large": { input: 2, output: 6 },
  "mistral-medium": { input: 0.4, output: 2 },
  "mistral-small": { input: 0.1, output: 0.3 },
  "codestral": { input: 0.3, output: 0.9 },
  "devstral": { input: 0.1, output: 0.3 },
}

const GROQ: Record<string, ModelPrice> = {
  "llama-3.3-70b": { input: 0.59, output: 0.79 },
  "llama-3.1-8b": { input: 0.05, output: 0.08 },
  "openai/gpt-oss-120b": { input: 0.15, output: 0.75 },
  "openai/gpt-oss-20b": { input: 0.1, output: 0.5 },
  "qwen/qwen3-32b": { input: 0.29, output: 0.59 },
  "moonshotai/kimi-k2": { input: 1, output: 3 },
}

/**
 * Per source, because the same bare id can cost differently on two hosts.
 * Aggregators (OpenRouter, Together, Fireworks) mostly pass the upstream id
 * through with a vendor prefix, so their lookup strips that and tries every
 * table.
 */
const BY_SOURCE: Record<string, Record<string, ModelPrice>> = {
  anthropic: ANTHROPIC,
  openai: OPENAI,
  google: GOOGLE,
  xai: XAI,
  deepseek: DEEPSEEK,
  mistral: MISTRAL,
  groq: GROQ,
}

const ALL_TABLES = Object.values(BY_SOURCE)

function longestPrefix(table: Record<string, ModelPrice>, model: string) {
  let best: { key: string; price: ModelPrice } | null = null
  for (const [key, price] of Object.entries(table)) {
    if (model === key || model.startsWith(key)) {
      if (!best || key.length > best.key.length) best = { key, price }
    }
  }
  return best?.price ?? null
}

const FREE: ModelPrice = { input: 0, output: 0 }

/**
 * The price of a model id, or `null` when it is not one this table knows.
 * `ollama/…` is a local model, as is any bare id run by the Ollama harness;
 * a bare id from another harness (`cursor` running `gpt-5`) is priced by
 * that harness, not here, so it stays unknown rather than reading as free.
 */
export function priceForModel(modelId: string, providerId?: string): ModelPrice | null {
  const id = modelId.trim()
  if (!id) return null
  const cut = id.indexOf("/")
  if (cut <= 0) return providerId === "ollama" ? FREE : null
  const source = id.slice(0, cut)
  const model = id.slice(cut + 1).toLowerCase()
  if (source === "ollama") return FREE

  const own = BY_SOURCE[source]
  if (own) return longestPrefix(own, model)

  // An aggregator: `anthropic/claude-sonnet-4-6`, `openai/gpt-4o`, …
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model
  for (const table of ALL_TABLES) {
    const hit = longestPrefix(table, bare) ?? longestPrefix(table, model)
    if (hit) return hit
  }
  return null
}

/** Dollars for one turn, or `null` when the model's price is unknown. */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  providerId?: string
): number | null {
  const price = priceForModel(modelId, providerId)
  if (!price) return null
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}

/** `$0.0042`, `$1.30`, `free` — sized to the magnitude of the number. */
export function formatCost(dollars: number): string {
  if (dollars === 0) return "free"
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`
  if (dollars < 1) return `$${dollars.toFixed(3)}`
  return `$${dollars.toFixed(2)}`
}
