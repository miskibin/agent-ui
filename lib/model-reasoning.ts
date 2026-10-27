/**
 * Which models a reasoning-effort control actually reaches.
 *
 * The composer used to offer Low…Extra High for every model of a provider
 * that could carry the setting at all, so a model with no reasoning took the
 * pick and quietly ignored it. The control is now offered per model, from the
 * best evidence there is for each kind of source:
 *
 * - **Ollama** says so itself: `/api/show` lists `thinking` among a model's
 *   capabilities (`fetchThinkingCapableModelIds`). That is authoritative.
 * - **A hosted OpenAI-compatible catalog** says nothing about it — `/models`
 *   carries ids and nothing else — so the id is read against the reasoning
 *   families below. Better a family list than a promise every model keeps.
 * - **What a request proved.** An endpoint that answered a request carrying
 *   `reasoning_effort` with a 400 about it has settled the question for that
 *   model, whatever its id looks like: `rememberEffortRejected` takes it out
 *   of the list for the rest of the process's life.
 *
 * Pure apart from that one in-memory set, and free of `node:`, so the id
 * rules are unit-tested.
 */

/**
 * Reasoning families, matched against the model part of an id (lowercased).
 * Each entry is a family that takes an effort or thinking budget, not merely
 * one that can be prompted to think out loud.
 */
const REASONING_PATTERNS: RegExp[] = [
  /(^|[^a-z0-9])o[1345](-|$)/, // OpenAI o-series
  /gpt-5/,
  /gpt-oss/,
  /claude-3[-.]7/,
  /claude-(sonnet|opus|haiku|fable)-[4-9]/,
  /claude-[4-9]/,
  /gemini-(2\.5|[3-9])/,
  /grok-3-mini/,
  /grok-[4-9]/,
  /deepseek-(reasoner|r1)/,
  /deepseek-v3\.[1-9]/,
  /deepseek-v[4-9]/,
  /(^|[^a-z])r1([^0-9]|$)/,
  /qwq/,
  /magistral/,
  /thinking/,
  /reasoning/,
  /phi-4-(mini-)?reasoning/,
  /kimi-k2-thinking/,
  /glm-4\.[5-9]|glm-[5-9]/,
  /minimax-m[1-9]/,
]

/**
 * Qwen 3 and later are hybrid thinkers — except the variants that were cut
 * to answer directly (`-instruct-2507`, the coders).
 */
const QWEN_HYBRID = /qwen-?[3-9]/
const QWEN_DIRECT = /coder|instruct|-vl-|embedding/

export function looksReasoningCapableId(id: string): boolean {
  const model = id.toLowerCase()
  if (QWEN_HYBRID.test(model) && !QWEN_DIRECT.test(model)) return true
  return REASONING_PATTERNS.some((pattern) => pattern.test(model))
}

const rejected = new Set<string>()

/** A request carrying effort was refused for this model: stop offering it. */
export function rememberEffortRejected(modelId: string): void {
  rejected.add(modelId)
}

export function effortRejected(modelId: string): boolean {
  return rejected.has(modelId)
}

/**
 * The hosted half of every provider's answer: ids whose model part looks like
 * a reasoning model and that no request has disproved.
 */
export function hostedEffortModels(ids: string[]): string[] {
  return ids.filter((id) => !rejected.has(id) && looksReasoningCapableId(id))
}
