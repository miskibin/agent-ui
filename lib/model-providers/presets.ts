/**
 * The OpenAI-compatible model providers the app ships knowing about.
 *
 * Client-safe on purpose: the settings schema, the settings UI and the server
 * catalog all need the same slugs, and a slug is the prefix of every composite
 * model id (`<slug>/<model>`) as well as a key in `settings.json` — so the list
 * has to be importable from both sides of the boundary.
 *
 * Every `baseUrl` ends at the version segment with no trailing slash: the
 * catalog appends `/models` and the chat path appends `/chat/completions`.
 */

export type ModelProviderPreset = {
  slug: string
  name: string
  baseUrl: string
}

export const MODEL_PROVIDER_PRESETS: ModelProviderPreset[] = [
  { slug: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { slug: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { slug: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1" },
  {
    slug: "google",
    name: "Google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  { slug: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { slug: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { slug: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { slug: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { slug: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1" },
  {
    slug: "fireworks",
    name: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
  },
]

/**
 * Slugs are separator-free and file-safe rather than escaped — they become
 * composite-model-id prefixes and object keys in `settings.json`, so a slug
 * carrying a `/` would silently redirect a model id.
 */
export const MODEL_PROVIDER_SLUG_RE = /^[a-z0-9-]{1,32}$/

/**
 * `ollama` names the local source, which is configured under
 * `settings.providers.ollama` — a second entry under the same name would make
 * `ollama/<model>` ambiguous, so normalization drops it.
 */
export const RESERVED_MODEL_PROVIDER_SLUGS = ["ollama"]
