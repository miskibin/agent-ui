import type { ModelSource } from "@/lib/model-providers/server"
import type { PermissionMode } from "@/lib/providers/types"

/**
 * tinyagent (github.com/vicgupta/tinyagent) as an ACP agent: what to spawn
 * for one turn, and where its models come from.
 *
 * tinyagent publishes no `configOptions` — its model, reasoning effort and
 * read-only mode are command-line flags read when the process starts — so
 * every one of them is decided here, per turn, and a turn that changes one
 * runs in a process of its own (`lib/acp-agent` keys its pool by the spawn).
 * The conversation still carries over: a fresh session is briefed with the
 * transcript.
 *
 * Its models are the app's own: `<source>/<model>`, the same composite id
 * the picker uses everywhere, is also exactly tinyagent's `-m` syntax for its
 * built-in providers. Every other source the app knows — a LiteLLM proxy, xAI,
 * Groq, a custom endpoint — is OpenAI-compatible, and reaches tinyagent as its
 * `openai` provider pointed at that base URL. No config file is generated, so
 * the user's own `~/.config/tinyagent/config.yaml` (profiles, hooks, MCP
 * servers) keeps applying.
 *
 * Pure: no `node:` imports, so `node --test` covers the mapping.
 */

/** The picker's id for "whatever tinyagent's own config says". */
export const TINYAGENT_DEFAULT_MODEL = "tinyagent/default"

/** Sources tinyagent speaks natively, by the app's slug. */
const NATIVE: Record<string, { keyEnv: string; baseUrlEnv?: string; defaultBaseUrl?: string }> = {
  openai: {
    keyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  anthropic: {
    keyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    defaultBaseUrl: "https://api.anthropic.com/v1",
  },
  openrouter: { keyEnv: "OPENROUTER_API_KEY" },
}

/** The app's effort ids → tinyagent's `--reasoning-effort` levels. */
const EFFORT: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  minimal: "minimal",
  none: "none",
}

export type TinyagentTurn = {
  /** Flags to put *before* the user's own args, so theirs win. */
  args: string[]
  env: Record<string, string>
  /** Why the turn cannot run, when the picked model's source is gone. */
  error?: string
}

/**
 * The flags and environment for one turn.
 *
 * `--plan` is on so `update_plan` reaches the app's plan panel; a user who
 * does not want it passes `--plan=false` in the agent's args, which come
 * after these and win.
 */
export function tinyagentTurn(input: {
  model?: string
  effort?: string
  permissionMode?: PermissionMode
  sources: ModelSource[]
  ollamaBaseUrl: string
}): TinyagentTurn {
  const args = ["--acp", "--plan"]
  const env: Record<string, string> = {}
  if (input.ollamaBaseUrl) env.OLLAMA_HOST = input.ollamaBaseUrl

  const model = input.model?.trim() ?? ""
  if (model && model !== TINYAGENT_DEFAULT_MODEL) {
    const slash = model.indexOf("/")
    const slug = slash > 0 ? model.slice(0, slash) : ""
    const name = slash > 0 ? model.slice(slash + 1) : model
    if (slug === "ollama") {
      if (!input.ollamaBaseUrl) {
        return { args, env, error: "No Ollama base URL set — pick another model or set one in Settings." }
      }
      args.push("-m", model)
    } else {
      const source = input.sources.find((entry) => entry.slug === slug)
      if (!source) {
        return {
          args,
          env,
          error: `Model provider "${slug || model}" is disabled or missing — pick another model.`,
        }
      }
      const native = NATIVE[slug]
      if (native) {
        args.push("-m", model)
        if (source.apiKey) env[native.keyEnv] = source.apiKey
        if (native.baseUrlEnv && source.baseUrl && source.baseUrl !== native.defaultBaseUrl) {
          env[native.baseUrlEnv] =
            slug === "anthropic" ? source.baseUrl.replace(/\/v1$/, "") : source.baseUrl
        }
      } else {
        // Any other OpenAI-compatible endpoint is tinyagent's `openai`
        // provider at that URL, over Chat Completions — the one transport
        // every compatible server (LiteLLM, vLLM, Groq, …) implements.
        args.push("-m", `openai/${name}`, "--openai-api", "chat")
        env.OPENAI_BASE_URL = source.baseUrl
        // tinyagent refuses to start its openai provider with no key at all;
        // a proxy that needs none accepts any.
        env.OPENAI_API_KEY = source.apiKey || "none"
      }
    }
  }

  const effort = input.effort ? EFFORT[input.effort] : undefined
  if (effort) args.push("--reasoning-effort", effort)
  if (input.permissionMode === "read-only") args.push("--read-only")
  return { args, env }
}

/** tinyagent's own read-only flag, as the user may have put it in args. */
export function argsForceReadOnly(args: string[]): boolean {
  let readOnly = false
  for (const arg of args) {
    if (arg === "--read-only" || arg === "-read-only" || arg === "--read-only=true") readOnly = true
    if (arg === "--read-only=false" || arg === "-read-only=false") readOnly = false
  }
  return readOnly
}
