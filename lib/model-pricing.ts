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
  /**
   * $ per 1M input tokens served from the prompt cache. Absent where the
   * host does not publish one, and then derived — see `CACHE_READ_RATIO`.
   */
  cacheRead?: number
  /** $ per 1M input tokens written *into* the cache. */
  cacheWrite?: number
}

/**
 * Anthropic prices caching as a fixed multiple of a model's own input rate
 * across the whole family — a read at a tenth, a five-minute write at a
 * quarter more — so the per-model figures below are that rule applied to each
 * entry's input price rather than nine hand-copied pairs that could drift
 * apart. Every other table has no published pair at all and falls back to the
 * same two ratios, which is the closest thing to a convention the hosts have.
 */
const CACHE_READ_RATIO = 0.1
const CACHE_WRITE_RATIO = 1.25

function anthropic(input: number, output: number): ModelPrice {
  return {
    input,
    output,
    cacheRead: input * CACHE_READ_RATIO,
    cacheWrite: input * CACHE_WRITE_RATIO,
  }
}

const ANTHROPIC: Record<string, ModelPrice> = {
  "claude-fable-5-1": anthropic(10, 50),
  "claude-fable-5": anthropic(10, 50),
  "claude-mythos-5-1": anthropic(10, 50),
  "claude-opus-5": anthropic(5, 25),
  "claude-opus-4-8": anthropic(5, 25),
  "claude-opus-4-7": anthropic(5, 25),
  "claude-opus-4-6": anthropic(5, 25),
  "claude-opus-4-5": anthropic(5, 25),
  "claude-opus-4-1": anthropic(15, 75),
  "claude-opus-4": anthropic(15, 75),
  "claude-sonnet-5": anthropic(2, 10),
  "claude-sonnet-4-6": anthropic(3, 15),
  "claude-sonnet-4-5": anthropic(3, 15),
  "claude-sonnet-4": anthropic(3, 15),
  "claude-3-7-sonnet": anthropic(3, 15),
  "claude-haiku-4-5": anthropic(1, 5),
  "claude-3-5-haiku": anthropic(0.8, 4),
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
 * The `claude` CLI takes a tier alias as readily as a full id, and an alias
 * carries no price of its own — it means "the latest of this tier", so it is
 * resolved to whatever that is today. A pinned id needs no entry here: the
 * table already matches it by prefix.
 */
const CLAUDE_CODE_ALIASES: Record<string, string> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
}

/**
 * A user's own price table, keyed exactly as the app spells a model id —
 * `<source>/<model>` for a hosted one, the bare tag for a harness that only
 * ever reports one (`sonnet`, `gpt-5-codex`). Prices are dollars per million
 * tokens, same units as the tables above, and `0` means free rather than
 * unknown: it is the one way to tell this app that a model on a subscription,
 * a local box or a free tier costs nothing.
 *
 * Kept as a plain record so it can be persisted verbatim in settings.json
 * (`usage.priceOverrides`) and passed straight in here.
 */
export type ModelPriceOverrides = Record<string, ModelPrice>

/**
 * The override for one id, if the user wrote one.
 *
 * Exact match on the trimmed id first — an override is written against the id
 * the usage table showed, so a prefix rule here would let `gpt-5` silently
 * re-price `gpt-5-nano`. The case-insensitive second pass exists only for a
 * hand-typed key, and still matches the *whole* id.
 */
function overrideFor(
  id: string,
  overrides: ModelPriceOverrides | undefined
): ModelPrice | null {
  if (!overrides) return null
  const direct = overrides[id]
  if (direct) return direct
  const lower = id.toLowerCase()
  for (const [key, price] of Object.entries(overrides)) {
    if (key.trim().toLowerCase() === lower) return price
  }
  return null
}

/**
 * The price of a model id, or `null` when it is not one this table knows.
 * `ollama/…` is a local model, as is any bare id run by the Ollama harness;
 * a bare id from another harness (`cursor` running `gpt-5`) is priced by
 * that harness, not here, so it stays unknown rather than reading as free.
 *
 * `claudeCode` is the exception to that last rule, because unlike Cursor it
 * does not resell anything: its bare ids *are* Anthropic ids billed at
 * Anthropic's own rates, which is exactly what this table holds. The number
 * is still an estimate and still shown as one — a subscription run has no
 * per-token bill at all — but it is the same estimate the CLI itself prints
 * as `total_cost_usd`, and it beats showing nothing.
 */
export function priceForModel(
  modelId: string,
  providerId?: string,
  overrides?: ModelPriceOverrides
): ModelPrice | null {
  const id = modelId.trim()
  if (!id) return null
  // The user's table wins over every rule below, including the ones that
  // answer without consulting a table at all: an override is the only way to
  // say what a model this app has never heard of costs, and the only way to
  // correct one it prices wrongly.
  const own = overrideFor(id, overrides)
  if (own) return own
  const cut = id.indexOf("/")
  if (cut <= 0) {
    if (providerId === "ollama") return FREE
    if (providerId !== "claudeCode") return null
    const bare = id.toLowerCase()
    return longestPrefix(ANTHROPIC, CLAUDE_CODE_ALIASES[bare] ?? bare)
  }
  const source = id.slice(0, cut)
  const model = id.slice(cut + 1).toLowerCase()
  if (source === "ollama") return FREE

  const table = BY_SOURCE[source]
  if (table) return longestPrefix(table, model)

  // An aggregator: `anthropic/claude-sonnet-4-6`, `openai/gpt-4o`, …
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model
  for (const candidate of ALL_TABLES) {
    const hit = longestPrefix(candidate, bare) ?? longestPrefix(candidate, model)
    if (hit) return hit
  }
  return null
}

/**
 * Every token a turn was billed for, split the way the backends report it.
 * `inputTokens` is the *uncached* half: a harness that reports cache reads
 * and writes separately (claude-code does) hands them over separately, and
 * they are charged at their own rates rather than folded in at the full one.
 */
export type TurnTokens = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  cacheCreationTokens?: number
}

/** Dollars for one turn, or `null` when the model's price is unknown. */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  providerId?: string,
  cache?: Pick<TurnTokens, "cachedInputTokens" | "cacheCreationTokens">,
  overrides?: ModelPriceOverrides
): number | null {
  const price = priceForModel(modelId, providerId, overrides)
  if (!price) return null
  const cacheRead = price.cacheRead ?? price.input * CACHE_READ_RATIO
  const cacheWrite = price.cacheWrite ?? price.input * CACHE_WRITE_RATIO
  return (
    (inputTokens * price.input +
      outputTokens * price.output +
      (cache?.cachedInputTokens ?? 0) * cacheRead +
      (cache?.cacheCreationTokens ?? 0) * cacheWrite) /
    1_000_000
  )
}

/**
 * Where a model's price came from, for a UI that has to say so: an override
 * the user wrote, this file's own list prices, or nothing at all. "unpriced"
 * is not "free" — see `lib/usage`, which counts such a turn's tokens and
 * keeps it out of every sum.
 */
export type PriceSource = "override" | "builtin" | "unpriced"

export function priceSource(
  modelId: string,
  providerId?: string,
  overrides?: ModelPriceOverrides
): PriceSource {
  if (overrideFor(modelId.trim(), overrides)) return "override"
  return priceForModel(modelId, providerId) ? "builtin" : "unpriced"
}

/** `$0.0042`, `$1.30`, `free` — sized to the magnitude of the number. */
export function formatCost(dollars: number): string {
  if (dollars === 0) return "free"
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`
  if (dollars < 1) return `$${dollars.toFixed(3)}`
  return `$${dollars.toFixed(2)}`
}
