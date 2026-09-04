import "server-only"

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { OllamaModel } from "@/lib/providers/ollama-api"
import type { DshSettings } from "@/lib/settings/schema"

/**
 * The generated configuration for the built-in DeepSeek Harness (`dsh`) agent,
 * mirroring what `lib/providers/pi.ts` does with pi's `models.json`.
 *
 * dsh composes its config from layers, the last of which is a `--patch` overlay
 * given on the command line. That overlay is where an OpenAI-compatible
 * endpoint (Ollama) gets declared as an extra LLM route — the same job pi's
 * generated `models.json` does. The file is JSON, which dsh's YAML loader
 * accepts, so nothing here hand-rolls YAML.
 *
 * ACP lives only on dsh's npm `alpha` tag; `latest` has no ACP bundle at all:
 *   npm i -g --no-audit --no-fund --ignore-scripts @deepseek-ai/dsh@0.1.2-alpha.3
 */

/** `dsh --profile acp` — the ACP profile takes no application flags. */
export const DSH_ACP_ARGS = ["--profile", "acp"]

/** The route key our generated overlay declares. */
export const DSH_OLLAMA_ROUTE = "ollama"

/**
 * dsh reads its credential through an env var *name* declared in config, never
 * a literal secret in the file.
 */
const OLLAMA_KEY_VAR = "AGENT_UI_ACP_OLLAMA_KEY"

/** Ollama ignores the value, but the adapter refuses a route with no credential. */
const OLLAMA_KEY_PLACEHOLDER = "ollama"

/** Matches the context window the verified overlay used. */
const OLLAMA_CONTEXT_WINDOW = 32_768

export function dshPatchPath(configDir: string) {
  return join(configDir, "patch.json")
}

/**
 * Environment for a spawned `dsh`.
 *
 * `DSH_HOME` points at `$AGENT_UI_DIR/<agent>` so the profile, settings and
 * session logs this app creates stay out of the user's own `~/.dsh` — the same
 * reasoning as `PI_CODING_AGENT_DIR` in `lib/pi-agent.ts`.
 *
 * `DSH_TELEMETRY_MODE` matters: dsh ships defaulting to `FEEDBACK_ONLY`, which
 * exports to `https://harness-telemetry.deepseeksvc.com/v1/logs`. `DISABLED` is
 * one of the three values its telemetry plugin accepts (`FULL`,
 * `FEEDBACK_ONLY`, `DISABLED`) and is the one that builds no exporter at all.
 */
export function dshEnv(
  configDir: string,
  settings: DshSettings
): Record<string, string> {
  const apiKey = settings.apiKey.trim()
  return {
    DSH_HOME: configDir,
    DSH_TELEMETRY_MODE: "DISABLED",
    DSH_PERMISSION_MODE: settings.sandbox,
    [OLLAMA_KEY_VAR]: OLLAMA_KEY_PLACEHOLDER,
    // An inherited DEEPSEEK_API_KEY still works; this only overrides it when
    // the user typed one into settings.
    ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : null),
  }
}

type DshPatchEntry = { id: string; config: Record<string, unknown> }

/**
 * Writes the `--patch` overlay declaring `baseUrl` as an OpenAI-compatible
 * route, and returns its path — or null when no base URL is configured, in
 * which case dsh runs on its own hosted DeepSeek route and needs no overlay.
 *
 * The overlay *adds* a route: DeepSeek's own models stay selectable alongside
 * the local ones.
 */
export async function writeDshPatch(
  configDir: string,
  baseUrl: string,
  models: Array<Pick<OllamaModel, "id" | "name">>
): Promise<string | null> {
  const url = baseUrl.trim().replace(/\/+$/, "")
  if (!url) return null

  const patch: DshPatchEntry[] = [
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          [DSH_OLLAMA_ROUTE]: {
            displayName: "Ollama",
            api: "openai-completions",
            baseURL: `${url}/v1`,
            apiKeyEnv: OLLAMA_KEY_VAR,
            // Declaring `models` replaces this route's catalog wholesale, and
            // declaring no `reasoningEfforts` is what keeps dsh from offering a
            // reasoning-effort option Ollama's OpenAI shim would reject.
            models: models.map((model) => ({
              id: model.id,
              name: model.name,
              contextWindow: OLLAMA_CONTEXT_WINDOW,
            })),
          },
        },
      },
    },
  ]

  const first = models[0]?.id
  if (first) {
    // Where a turn starts before the UI picks a model — including subagents,
    // which resolve `agent-default-model` rather than the ACP session's route.
    const route = { provider: DSH_OLLAMA_ROUTE, model: first }
    patch.push({ id: "acp", config: route })
    patch.push({ id: "agent-default-model", config: route })
  }

  const serialized = `${JSON.stringify(patch, null, 2)}\n`
  const path = dshPatchPath(configDir)
  // dsh's acp profile is `patchReload: startup`, so this is only read when a
  // process spawns — but rewriting an unchanged file every turn is still churn.
  const current = await readFile(path, "utf8").catch(() => null)
  if (current === serialized) return path
  await mkdir(configDir, { recursive: true })
  // A concurrent turn may spawn a dsh that reads this overlay at any moment, so
  // it is replaced rather than rewritten: a reader sees the whole old file or
  // the whole new one, never a half-written one.
  const tmp = `${path}.${process.pid.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`
  await writeFile(tmp, serialized, "utf8")
  await rename(tmp, path)
  return path
}

/** The opaque `configOptions` value dsh uses to name one route's model. */
export function dshModelValue(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}
