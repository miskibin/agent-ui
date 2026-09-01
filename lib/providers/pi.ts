import "server-only"

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { ModelOption } from "@/components/ui/model-picker"
import { joinModelId, splitModelId } from "@/lib/model-providers/ids"
import {
  enabledModelSources,
  listSourceModels,
  type ModelSource,
} from "@/lib/model-providers/server"
import { hasPiBinary } from "@/lib/pi-runtime"
import { withSystemPrefix } from "@/lib/providers/system-prefix"
import {
  fetchOllamaModels,
  normalizeBaseUrl,
  ollamaReachErrorMessage,
  probeOllama,
  toModelOption,
  type OllamaModel,
} from "@/lib/providers/ollama-api"
import { dataDir } from "@/lib/settings/server"
import type { AppSettings, PiSettings } from "@/lib/settings/schema"
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  ProviderInfo,
} from "@/lib/providers/types"

export const PI_PROVIDER_ID = "pi"

/** The local server's slug — the `ollama` half of `ollama/<model>`. */
const OLLAMA_SOURCE = "ollama"

/**
 * The `pi` CLI (https://pi.dev) driving local Ollama models *and* whatever
 * OpenAI-compatible model providers are configured — the minimal agentic
 * harness: four tools (read / write / edit / bash), one subprocess per turn,
 * sessions on disk.
 *
 * pi reaches every endpoint through the `models.json` we generate under
 * `$AGENT_UI_DIR/pi`: one entry per source, addressed the same
 * `<provider>/<model>` way this app spells a composite model id. Pointing
 * `PI_CODING_AGENT_DIR` there keeps that generated config — and the sessions
 * this app starts — out of the user's own `~/.pi/agent`.
 */
export function createPiProvider(
  settings: PiSettings,
  ollamaBaseUrl: string,
  appSettings: AppSettings
): AgentProvider {
  const baseUrl = normalizeBaseUrl(ollamaBaseUrl)
  const sources = enabledModelSources(appSettings)
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
      const configureBinary =
        process.platform === "win32" &&
        settings.enabled &&
        !hasPiBinary(binPath)
      if (!available) {
        return { ...base, unavailableReason: reason, configureBinary }
      }
      const reachable = await probeOllama(baseUrl)
      return reachable
        ? { ...base, available: true }
        : { ...base, unavailableReason: `No server at ${baseUrl}` }
    },

    async listModels(): Promise<ModelOption[]> {
      const models = await fetchOllamaModels(baseUrl)
      const remote = await collectSourceModels(sources)
      await writeModelsConfig(configDir, baseUrl, models, remote)
      return [
        ...models.map((model) => ({
          ...toModelOption(model),
          id: joinModelId(OLLAMA_SOURCE, model.id),
          group: OLLAMA_SOURCE,
        })),
        ...remote.flatMap(({ source, models: listed }) =>
          listed.map((model) => ({
            id: joinModelId(source.slug, model.id),
            name: model.name,
            group: source.slug,
          }))
        ),
      ]
    },

    async listModelGroups() {
      return [
        { id: OLLAMA_SOURCE, label: "Ollama" },
        ...sources.map((source) => ({ id: source.slug, label: source.name })),
      ]
    },

    async *run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
      // Writing the catalog and spawning the CLI both happen before a single
      // token exists, and both can be slow enough to look like a hang.
      yield {
        type: "status",
        stage: "connecting",
        text: "Pointing pi at the Ollama catalog",
      }
      // pi resolves `--model` against its own catalog, so the config has to
      // know about the tag before the process starts.
      const selected = splitModelId(options.model)
      try {
        const models = await fetchOllamaModels(baseUrl)
        const remote = await collectSourceModels(sources)
        await writeModelsConfig(
          configDir,
          baseUrl,
          models,
          // A source whose catalog could not be listed would otherwise leave
          // pi unable to resolve the very model that was picked from it.
          withSelected(remote, selected)
        )
      } catch (err) {
        yield { type: "error", message: ollamaReachErrorMessage(err, baseUrl) }
        return
      }

      yield {
        type: "status",
        stage: "loading",
        text: `Starting pi with ${selected.model}`,
      }
      const { runPiAgent } = await import("@/lib/pi-agent")
      yield* runPiAgent({
        prompt: withSystemPrefix(options.prompt, options.system),
        // pi addresses models exactly the way a composite id spells them.
        model: joinModelId(selected.source, selected.model),
        sessionId: options.sessionId,
        thinking: options.effort,
        // A per-chat folder beats the one workspace from settings.
        workspace: options.cwd?.trim() || workspace,
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

type SourceModels = {
  source: ModelSource
  models: Array<{ id: string; name: string }>
}

/**
 * Every configured source's catalog, in settings order. A source that cannot
 * be listed (key rejected, endpoint down) contributes an empty list rather
 * than failing the call: one misconfigured provider must not take the whole
 * model picker — or a running turn — down with it.
 */
async function collectSourceModels(
  sources: ModelSource[]
): Promise<SourceModels[]> {
  return Promise.all(
    sources.map(async (source) => ({
      source,
      models: await listSourceModels(source).catch(() => []),
    }))
  )
}

/** Ensures the picked model is in its own source's list — see the call site. */
function withSelected(
  listed: SourceModels[],
  selected: { source: string; model: string }
): SourceModels[] {
  return listed.map((entry) =>
    entry.source.slug === selected.source &&
    !entry.models.some((model) => model.id === selected.model)
      ? {
          ...entry,
          models: [...entry.models, { id: selected.model, name: selected.model }],
        }
      : entry
  )
}

/**
 * Regenerates `models.json` from whatever Ollama is currently serving plus one
 * entry per configured model provider, keyed by slug so pi's own
 * `<provider>/<model>` addressing matches this app's composite ids.
 *
 * Ollama's `apiKey` is a placeholder it ignores — pi hides models it considers
 * unauthenticated, so a dummy value is what makes them selectable, and a
 * keyless custom endpoint gets the same treatment. The `compat` flags turn off
 * two things Ollama's OpenAI shim rejects: the `developer` role and
 * `reasoning_effort`.
 */
async function writeModelsConfig(
  configDir: string,
  baseUrl: string,
  models: OllamaModel[],
  sources: SourceModels[]
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
      ...Object.fromEntries(
        sources.map(({ source, models: listed }) => [
          source.slug,
          {
            baseUrl: source.baseUrl,
            api: "openai-completions",
            apiKey: source.apiKey || "placeholder",
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
            },
            models: listed.map((model) => ({ id: model.id, name: model.name })),
          },
        ])
      ),
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
