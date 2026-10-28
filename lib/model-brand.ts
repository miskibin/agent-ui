/**
 * Which brand mark a model, a model source or a harness gets — read off its
 * id, because no catalog says who made a model. `qwen/qwen3-coder` on
 * OpenRouter, `qwen3:8b` pulled into Ollama and `hf.co/unsloth/Qwen3-…` are
 * one family, and the mark follows the family rather than where it is served.
 *
 * Returns slugs of `components/brand-marks.ts` (plus the two lucide stand-ins
 * `ProviderLogo` knows), never elements: this module is pure so it can be unit
 * tested and imported anywhere without pulling the path data along.
 */

/** Ahead of a token: start of the id or anything that is not a letter. */
const BEFORE = "(?:^|[^a-z])"

/**
 * One rule per family: the brand, and the tokens that name it. Every token is
 * anchored to a non-letter on its left, so `llama` matches `meta-llama/…` and
 * `llama3.2` but not `tinyllama`; short ones also carry a right-hand guard.
 */
const MODEL_FAMILIES: ReadonlyArray<readonly [brand: string, tokens: string]> = [
  ["claude", "claude|anthropic|sonnet|opus|haiku"],
  ["gemma", "gemma|codegemma|shieldgemma|paligemma"],
  ["gemini", "gemini|learnlm|palm(?![a-z])"],
  [
    "openai",
    "gpt|chatgpt|openai|codex|o[1-9](?![a-z0-9])|davinci|babbage|dall-?e|whisper|tts-1|text-embedding|omni-moderation|sora",
  ],
  ["deepseek", "deepseek"],
  ["qwen", "qwen|qwq|qvq|codeqwen|tongyi"],
  ["meta", "llama|codellama|meta(?![a-z])"],
  [
    "mistral",
    "mistral|mixtral|codestral|ministral|magistral|devstral|pixtral|voxtral|mathstral",
  ],
  ["grok", "grok|x-ai|xai(?![a-z])"],
  ["kimi", "kimi|moonshot"],
  ["zai", "glm|chatglm|codegeex|zhipu|thudm|z-ai|zai(?![a-z])"],
  ["minimax", "minimax|abab"],
  ["cohere", "cohere|c4ai|command-[a-z]|aya(?![a-z])"],
  ["nvidia", "nvidia|nemotron"],
  ["microsoft", "microsoft|phi-?[0-9]|phi(?![a-z])|wizardlm|orca(?![a-z])"],
  ["ibm", "granite|ibm(?![a-z])"],
  ["yi", "yi(?![a-z])|01-ai"],
  ["baichuan", "baichuan"],
  ["stepfun", "stepfun|step-?[0-9]"],
  ["hunyuan", "hunyuan|tencent"],
  ["doubao", "doubao|bytedance|seed-|ui-tars"],
  ["ai21", "ai21|jamba"],
  ["perplexity", "perplexity|sonar(?![a-z])|r1-1776"],
  ["tii", "tiiuae|falcon"],
  ["liquid", "liquid|lfm"],
  ["ai2", "allenai|olmo|molmo|tulu"],
  ["upstage", "upstage|solar(?![a-z])"],
  ["huggingface", "huggingfaceh4|smollm|zephyr"],
  ["longcat", "longcat|meituan"],
  ["wenxin", "ernie|baidu|wenxin"],
  ["deepcogito", "cogito"],
  ["baai", "baai|bge(?![a-z])"],
  ["cursor", "composer(?![a-z])|cursor"],
]

const FAMILY_PATTERNS = MODEL_FAMILIES.map(
  ([brand, tokens]) => [brand, new RegExp(`${BEFORE}(?:${tokens})`)] as const
)

/** Sources whose id is not a mark's slug. */
const SOURCE_ALIASES: Record<string, string> = {
  "together-ai": "together",
  togetherai: "together",
  "fireworks-ai": "fireworks",
  fireworksai: "fireworks",
  "lm-studio": "lmstudio",
  "amazon-bedrock": "bedrock",
  vertex: "vertexai",
  "azure-openai": "azure",
  silicon: "siliconcloud",
  siliconflow: "siliconcloud",
  dashscope: "alibaba",
  zhipuai: "zai",
  "z-ai": "zai",
  "x-ai": "xai",
}

/** Every slug a source may resolve to on its own — `brand-marks.ts` keys. */
const SOURCE_SLUGS = new Set([
  "openai", "anthropic", "google", "xai", "deepseek", "mistral", "openrouter",
  "ollama", "groq", "together", "fireworks", "cerebras", "deepinfra",
  "lmstudio", "vllm", "azure", "bedrock", "vertexai", "novita", "nebius",
  "sambanova", "hyperbolic", "siliconcloud", "moonshot", "alibaba", "cohere",
  "nvidia", "perplexity", "huggingface", "zai", "qwen", "minimax",
])

const cache = new Map<string, string | null>()
const CACHE_LIMIT = 512

/**
 * The family a model id names, or null. Every family is tried and the one
 * whose token comes *first* wins, so `deepseek-r1-distill-qwen-32b` is a
 * DeepSeek and `hf.co/unsloth/Qwen3-8B-GGUF` is a Qwen: a model's own name
 * leads, what it was distilled from or quantized by trails. Ties go to the
 * earlier rule.
 */
export function modelFamily(modelId: string): string | null {
  const id = modelId.trim().toLowerCase()
  if (!id) return null
  const hit = cache.get(id)
  if (hit !== undefined) return hit

  let best: string | null = null
  let bestAt = Infinity
  for (const [brand, pattern] of FAMILY_PATTERNS) {
    const match = pattern.exec(id)
    if (!match) continue
    // The index is the boundary character's, which orders matches the same.
    if (match.index < bestAt) {
      best = brand
      bestAt = match.index
    }
  }

  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(id, best)
  return best
}

/**
 * The mark for a model source — a settings `modelProviders` slug, `ollama`, an
 * OpenRouter vendor prefix — or null. A custom source named after the family it
 * serves (`my-qwen-proxy`) gets that family's mark.
 */
export function sourceBrand(source: string): string | null {
  const slug = source.trim().toLowerCase()
  if (!slug) return null
  const aliased = SOURCE_ALIASES[slug] ?? slug
  if (SOURCE_SLUGS.has(aliased)) return aliased
  return modelFamily(slug)
}

/**
 * The mark for a model: its family, else the source it is served from (the
 * first segment of a composite `<source>/<model>` id, or `source` when the
 * caller knows it), else null.
 */
export function modelBrand(modelId: string, source?: string): string | null {
  const family = modelFamily(modelId)
  if (family) return family
  if (source) return sourceBrand(source)
  const slash = modelId.indexOf("/")
  return slash > 0 ? sourceBrand(modelId.slice(0, slash)) : null
}

/** Built-in harness ids whose mark is not the id itself. */
const HARNESS_IDS: Record<string, string> = {
  claudeCode: "claudecode",
  cursorAgent: "cursor",
  codex: "codex",
  pi: "pi",
  ollama: "ollama",
  chat: "chat",
  mock: "mock",
}

/**
 * An ACP agent is configured, not coded, so its key and name are all there is
 * to go on. Harness marks first — `claude-code-acp` is Claude Code, not Claude
 * — then the families, for an agent named after its vendor (`qwen-code`).
 */
const HARNESS_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["claudecode", /claude/],
  ["codex", /codex/],
  ["geminicli", /gemini/],
  ["cursor", /cursor/],
  ["opencode", /open-?code/],
  ["githubcopilot", /copilot/],
  ["cline", /cline/],
  ["goose", /goose/],
  ["roocode", /(?:^|[^a-z])roo/],
  ["kilocode", /kilo/],
  ["openhands", /openhands|open-hands/],
  ["windsurf", /windsurf|codeium/],
  ["amp", /(?:^|[^a-z])amp(?![a-z])/],
  ["kiro", /kiro/],
  ["deepseek", /(?:^|[^a-z])dsh(?![a-z])/],
  ["mistral", /(?:^|[^a-z])vibe(?![a-z])/],
]

/** Mirrored from `lib/providers/acp` (server-only): ACP agents are `acp:<key>`. */
const ACP_PREFIX = "acp:"

/**
 * The mark for a harness — a provider id, with its display name as a second
 * clue for configured ACP agents — or null.
 */
export function harnessBrand(providerId: string, name = ""): string | null {
  const builtIn = HARNESS_IDS[providerId]
  if (builtIn) return builtIn
  const key = providerId.startsWith(ACP_PREFIX)
    ? providerId.slice(ACP_PREFIX.length)
    : providerId
  const text = `${key} ${name}`.toLowerCase()
  for (const [brand, pattern] of HARNESS_PATTERNS) {
    if (pattern.test(text)) return brand
  }
  return modelFamily(text)
}
