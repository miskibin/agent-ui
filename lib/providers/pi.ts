import "server-only"

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { ModelOption } from "@/components/ui/model-picker"
import { hasPiBinary } from "@/lib/pi-runtime"
import {
  fetchOllamaModels,
  normalizeBaseUrl,
  ollamaReachErrorMessage,
  probeOllama,
  toModelOption,
  type OllamaModel,
} from "@/lib/providers/ollama-api"
import { dataDir } from "@/lib/settings/server"
import type { PiSettings } from "@/lib/settings/schema"
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  ProviderInfo,
} from "@/lib/providers/types"

export const PI_PROVIDER_ID = "pi"

/**
 * The `pi` CLI (https://pi.dev) driving local Ollama models — the minimal
 * agentic harness: four tools (read / write / edit / bash), one subprocess per
 * turn, sessions on disk.
 *
 * pi reaches Ollama through its OpenAI-compatible endpoint, declared in a
 * `models.json` we generate under `$AGENT_UI_DIR/pi`. Pointing
 * `PI_CODING_AGENT_DIR` there keeps that generated config — and the sessions
 * this app starts — out of the user's own `~/.pi/agent`.
 */
export function createPiProvider(
  settings: PiSettings,
  ollamaBaseUrl: string
): AgentProvider {
  const baseUrl = normalizeBaseUrl(ollamaBaseUrl)
  const binPath = settings.binPath.trim()
  const workspace = settings.workspace.trim() || process.cwd()
  const configDir = join(dataDir(), "pi")
  const sessionDir = join(configDir, "sessions")

  const detect = (): { available: boolean; reason?: string } => {
    if (!settings.enabled) {
      return { available: false, reason: "Disabled in settings" }
    }
    if (!baseUrl) return { available: false, reason: "No Ollama base URL set" }
    if (!hasPiBinary(binPath)) {
      return {
        available: false,
        reason: binPath
          ? `No binary at ${binPath}`
          : "`pi` binary not found on PATH",
      }
    }
    return { available: true }
  }

  return {
    async info(): Promise<ProviderInfo> {
      const base: ProviderInfo = {
        id: PI_PROVIDER_ID,
        name: "pi (Ollama)",
        description: `Agentic harness over ${baseUrl || "an unset URL"} — read, write, edit, bash.`,
        capabilities: {
          tools: true,
          // pi keeps the transcript in its own session file on disk.
          resume: true,
          // Maps straight onto pi's `--thinking` levels.
          effort: true,
          vision: false,
        },
        available: false,
      }
      const { available, reason } = detect()
      if (!available) return { ...base, unavailableReason: reason }
      const reachable = await probeOllama(baseUrl)
      return reachable
        ? { ...base, available: true }
        : { ...base, unavailableReason: `No server at ${baseUrl}` }
    },

    async listModels(): Promise<ModelOption[]> {
      const models = await fetchOllamaModels(baseUrl)
      await writeModelsConfig(configDir, baseUrl, models)
      return models.map(toModelOption)
    },

    async *run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
      // pi resolves `--model` against its own catalog, so the config has to
      // know about the tag before the process starts.
      try {
        const models = await fetchOllamaModels(baseUrl)
        await writeModelsConfig(configDir, baseUrl, models)
      } catch (err) {
        yield { type: "error", message: ollamaReachErrorMessage(err, baseUrl) }
        return
      }

      const { runPiAgent } = await import("@/lib/pi-agent")
      yield* runPiAgent({
        prompt: options.prompt,
        model: `ollama/${options.model}`,
        sessionId: options.sessionId,
        thinking: options.effort,
        workspace,
        configDir,
        sessionDir,
        binPath,
        signal: options.signal,
      })
    },
  }
}

type ModelsConfig = {
  providers: Record<
    string,
    {
      baseUrl: string
      api: string
      apiKey: string
      compat: Record<string, boolean>
      models: Array<{ id: string; name: string }>
    }
  >
}

/**
 * Regenerates `models.json` from whatever Ollama is currently serving.
 * `apiKey` is a placeholder Ollama ignores — pi hides models it considers
 * unauthenticated, so a dummy value is what makes them selectable. The `compat`
 * flags turn off two things Ollama's OpenAI shim rejects: the `developer` role
 * and `reasoning_effort`.
 */
async function writeModelsConfig(
  configDir: string,
  baseUrl: string,
  models: OllamaModel[]
) {
  const config: ModelsConfig = {
    providers: {
      ollama: {
        baseUrl: `${baseUrl}/v1`,
        api: "openai-completions",
        apiKey: "ollama",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        models: models.map((model) => ({ id: model.id, name: model.name })),
      },
    },
  }
  const serialized = `${JSON.stringify(config, null, 2)}\n`
  const path = join(configDir, "models.json")
  // Rewriting on every turn would churn the file for nothing; models only
  // change when the user pulls or removes one.
  const current = await readFile(path, "utf8").catch(() => null)
  if (current === serialized) return
  await mkdir(configDir, { recursive: true })
  await writeFile(path, serialized, "utf8")
}
