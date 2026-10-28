/**
 * How large a model's context window is, when nothing better has said.
 *
 * The composer's ring needs a denominator *before* the first turn, and most
 * backends never volunteer one up front: an OpenAI-compatible `/models` is a
 * list of ids, Cursor's catalog is names, Codex reports its window only once a
 * turn has run. So this is the last of three sources, in order of how much
 * they are worth:
 *
 *   1. the window the backend reported for this chat's last turn
 *      (`metadata.contextWindow` — the one that is actually true);
 *   2. the window the provider's catalog published (Ollama's served `num_ctx`,
 *      OpenRouter's `context_length`, …) — `catalogContextLength` reads it;
 *   3. the window the model's *maker* publishes for that family, below.
 *
 * The table is deliberately a list of families with published numbers and
 * nothing else. A model it does not know gets no number — a ring reading
 * "12% used" against a guessed 128k is worse than no ring, because it is
 * believed. And a local Ollama tag never matches: Ollama serves whatever
 * `num_ctx` it was given, not what the architecture allows.
 *
 * Pure and import-free, like `lib/model-pricing`: the page and the server
 * read the same answer.
 */

export type ContextWindowSource = "reported" | "catalog" | "published"

/** A tag after a colon is Ollama's (`qwen3:8b`) — never answered from here. */
const OLLAMA_TAG = /:[^/]+$/

/**
 * First match wins, so a narrower family sits above the broader one it would
 * otherwise fall into (`gpt-5-chat` before `gpt-5`, `o1-mini` before `o1`).
 */
const PUBLISHED: Array<[RegExp, number]> = [
  // An explicit long-context variant says so in its id.
  [/\[1m\]$|-1m$/, 1_000_000],

  // Anthropic — and the tier aliases and spellings harnesses use for it
  // (`sonnet`, `claude-4.5-sonnet`, `opus-4.1`).
  [/^(claude|sonnet|opus|haiku|fable|mythos)(\b|-|$)/, 200_000],

  // OpenAI.
  [/^gpt-5(\.\d+)?-chat/, 128_000],
  [/^gpt-5/, 400_000],
  [/^gpt-4\.1|^gpt-4-1/, 1_047_576],
  [/^(chatgpt-4o|gpt-4o|gpt-4-turbo)/, 128_000],
  [/^o1-mini/, 128_000],
  [/^(o1|o3|o4-mini|codex-mini)(\b|-|$)/, 200_000],

  // Google.
  [/^gemini-1\.5-pro/, 2_097_152],
  [/^gemini-(1\.5|2\.0|2\.5|3)/, 1_048_576],

  // xAI.
  [/^grok-4(\.\d+)?-fast/, 2_000_000],
  [/^grok-code-fast/, 256_000],
  [/^grok-4/, 256_000],
  [/^grok-3/, 131_072],

  // DeepSeek's API serves 128k for both since V3.1.
  [/^deepseek-(chat|reasoner|v3)/, 128_000],

  // Mistral.
  [/^codestral/, 256_000],
  [/^(mistral-(large|medium|small)|devstral|ministral)/, 131_072],

  // Open-weight families as the hosted providers serve them.
  [/^llama-3\.[13]/, 131_072],
  [/^qwen3-coder/, 262_144],
  [/^kimi-k2-(0905|turbo|thinking)/, 262_144],
  [/^kimi-k2/, 131_072],
  [/^glm-4\.6/, 200_000],
  [/^glm-4\.5/, 131_072],
]

/**
 * The published window for a model id, in any of the spellings this app
 * sees: bare (`gpt-5`), composite (`openai/gpt-5`), and composite around a
 * catalog that nests its own vendor (`openrouter/anthropic/claude-sonnet-4`).
 * `undefined` for a local model and for anything not in the table.
 */
export function publishedContextWindow(modelId: string | undefined): number | undefined {
  const id = modelId?.trim().toLowerCase()
  if (!id) return undefined
  if (id.startsWith("ollama/") || OLLAMA_TAG.test(id)) return undefined
  const name = id.slice(id.lastIndexOf("/") + 1)
  if (!name) return undefined
  for (const [pattern, tokens] of PUBLISHED) {
    if (pattern.test(name)) return tokens
  }
  return undefined
}

/** Field names hosted `/models` catalogs use for the window, in the wild. */
const CATALOG_FIELDS = [
  "context_length", // OpenRouter, Together, Fireworks
  "context_window", // Groq
  "max_context_length", // Mistral
  "contextWindow",
  "contextLength",
  "max_model_len", // vLLM
  "input_token_limit", // Google
] as const

/** The window one `/models` entry states about itself, when it states one. */
export function catalogContextLength(entry: unknown): number | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const record = entry as Record<string, unknown>
  for (const field of CATALOG_FIELDS) {
    const value = Number(record[field])
    if (Number.isFinite(value) && value >= 1_024) return Math.round(value)
  }
  return undefined
}
