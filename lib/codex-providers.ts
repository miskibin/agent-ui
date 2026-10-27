import type { ModelSource } from "@/lib/model-providers/server"

/**
 * Codex on the app's own model providers.
 *
 * Codex is open source and speaks to any endpoint declared under
 * `model_providers` in its config — so the providers configured once in
 * Settings → Model providers (a LiteLLM proxy, OpenRouter, a local Ollama)
 * are handed to it rather than configured a second time in
 * `~/.codex/config.toml`. Three decisions shape how:
 *
 * - **Startup overrides, not the user's file.** Each source goes in as one
 *   `-c model_providers.<id>={…}` on the `codex app-server` command line,
 *   and the thread picks it with `modelProvider`. The user's config.toml is
 *   never written, and keeps applying for everything else. Per-thread
 *   `config` overrides on `thread/start` were the other way, and are the one
 *   app-server is known to hang a turn on.
 * - **Namespaced ids.** `agentui-<slug>`, so an app source called `openai`
 *   cannot collide with Codex's built-in `openai` provider and its login.
 * - **Keys in the environment.** A provider names its key by variable
 *   (`env_key`); the value travels in the spawned process's environment and
 *   never on a command line another process can read.
 *
 * Codex accepts only the Responses wire API (`wire_api = "chat"` was removed
 * in early 2026), so a source has to serve `/responses`: OpenAI, OpenRouter,
 * LiteLLM and current Ollama do; a chat-completions-only endpoint answers
 * the turn with an error that says so.
 *
 * Pure — no `node:` imports — so the mapping is unit-tested.
 */

const PREFIX = "agentui-"

/** The local server's source slug, as the app's composite ids spell it. */
export const OLLAMA_SOURCE = "ollama"

export function codexProviderId(slug: string): string {
  return `${PREFIX}${slug}`
}

function keyEnvName(slug: string): string {
  return `AGENT_UI_CODEX_KEY_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
}

/** A TOML basic string. JSON's escaping is a subset TOML reads the same way. */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

export type CodexOverrides = { args: string[]; env: Record<string, string> }

/**
 * The `-c` arguments and environment that declare every source to Codex.
 * Empty when there are none, which leaves the spawn exactly as it was.
 */
export function codexProviderOverrides(
  sources: ModelSource[],
  ollamaBaseUrl: string
): CodexOverrides {
  const args: string[] = []
  const env: Record<string, string> = {}
  const declare = (slug: string, name: string, baseUrl: string, apiKey: string) => {
    const fields = [
      `name = ${tomlString(name)}`,
      `base_url = ${tomlString(baseUrl)}`,
      `wire_api = "responses"`,
    ]
    if (apiKey) {
      const variable = keyEnvName(slug)
      env[variable] = apiKey
      fields.push(`env_key = ${tomlString(variable)}`)
    }
    args.push("-c", `model_providers.${codexProviderId(slug)}={ ${fields.join(", ")} }`)
  }
  if (ollamaBaseUrl) declare(OLLAMA_SOURCE, "Ollama", `${ollamaBaseUrl}/v1`, "")
  for (const source of sources) {
    declare(source.slug, source.name, source.baseUrl, source.apiKey)
  }
  return { args, env }
}

/**
 * Which provider a picked model runs on. The app's sources hand out composite
 * `<slug>/<model>` ids; Codex's own models are bare (`gpt-5.1-codex`) and run
 * on whatever the user's Codex is signed in to.
 */
export function splitCodexModel(
  model: string,
  sources: ModelSource[],
  hasOllama: boolean
): { provider?: string; model: string } {
  const slash = model.indexOf("/")
  if (slash <= 0) return { model }
  const slug = model.slice(0, slash)
  const known =
    (slug === OLLAMA_SOURCE && hasOllama) || sources.some((source) => source.slug === slug)
  return known ? { provider: codexProviderId(slug), model: model.slice(slash + 1) } : { model }
}
