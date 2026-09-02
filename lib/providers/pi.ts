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
import { withPromptContext } from "@/lib/providers/system-prefix"
import {
  fetchOllamaContextLengths,
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
 * The `pi` CLI (https://pi.dev) driving whatever model sources are configured —
 * the local Ollama server, the OpenAI-compatible providers under
 * `settings.modelProviders`, or either on its own. The minimal agentic harness:
 * four tools (read / write / edit / bash), one subprocess per turn, sessions on
 * disk.
 *
 * Ollama is one source among several here, not a requirement: a machine with no
 * local server but a DeepSeek key still gets the harness, and a machine with
 * neither is what makes it unavailable.
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
        name: "pi",
        description: `Agentic harness over ${sourceSummary(baseUrl, sources)} — read, write, edit, bash.`,
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
      // A catalog is what makes the harness usable, and either kind of source
      // supplies one. Ollama being down only matters when nothing else is
      // configured — a hosted key alone is a working setup.
      if (baseUrl && (await probeOllama(baseUrl))) {
        return { ...base, available: true }
      }
      if (sources.length > 0) return { ...base, available: true }
      return {
        ...base,
        unavailableReason: baseUrl
          ? `No server at ${baseUrl}, and no model providers configured`
          : "No Ollama URL and no model providers configured",
      }
    },

    async listModels(): Promise<ModelOption[]> {
      // Independent catalogs: a slow hosted source must not queue behind
      // Ollama, nor Ollama behind it.
      const [models, remote] = await Promise.all([
        collectLocalModels(baseUrl),
        collectSourceModels(sources),
      ])
      await writeModelsConfig(configDir, baseUrl, models, remote)
      // Only the local ones: a hosted source does not tell us its window, and
      // guessing one would put a confidently wrong number under the composer.
      const contexts = models.length
        ? await fetchOllamaContextLengths(baseUrl, models)
        : {}
      return [
        ...models.map((model) => ({
          ...toModelOption(model, contexts[model.id]),
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
        // No local server configured, no heading for it — the picker would
        // otherwise carry a permanently empty section.
        ...(baseUrl ? [{ id: OLLAMA_SOURCE, label: "Ollama" }] : []),
        ...sources.map((source) => ({ id: source.slug, label: source.name })),
      ]
    },

    async *run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
      const selected = splitModelId(options.model)
      // A model whose source has since been switched off, deleted, or (for the
      // local server) unset would otherwise reach pi as an unresolvable
      // `--model` and come back as the CLI's own wording.
      const known =
        selected.source === OLLAMA_SOURCE
          ? !!baseUrl
          : sources.some((source) => source.slug === selected.source)
      if (!known) {
        yield {
          type: "error",
          message:
            selected.source === OLLAMA_SOURCE
              ? "No Ollama base URL set — pick a hosted model or set one in Settings."
              : `Model provider "${selected.source}" is disabled or missing — pick another model.`,
        }
        return
      }

      // Writing the catalog and spawning the CLI both happen before a single
      // token exists, and both can be slow enough to look like a hang.
      yield {
        type: "status",
        stage: "connecting",
        text: "Pointing pi at the model catalog",
      }
      // pi resolves `--model` against its own catalog, so the config has to
      // know about the tag before the process starts.
      try {
        // Listed together: one unreachable source must not add its whole
        // timeout to the wait before the first token.
        const [models, remote] = await Promise.all([
          collectLocalModels(baseUrl),
          collectSourceModels(sources),
        ])
        await writeModelsConfig(
          configDir,
          baseUrl,
          // Same reason as the hosted sources below: a local server that did
          // not answer must not cost the picked tag its catalog entry.
          withSelectedLocal(models, selected),
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
        prompt: withPromptContext(options.prompt, options),
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

/** How the harness describes what it is pointed at, for the picker's subtitle. */
function sourceSummary(baseUrl: string, sources: ModelSource[]) {
  const names = [
    ...(baseUrl ? ["Ollama"] : []),
    ...sources.map((source) => source.name),
  ]
  if (names.length === 0) return "no configured model source"
  if (names.length <= 2) return names.join(" and ")
  return `${names[0]} and ${names.length - 1} more model providers`
}

/**
 * The local server's catalog, or nothing. Unlike the plain `ollama` provider
 * this one is a source among several: an unset URL or a server that is not
 * answering leaves the hosted sources to carry the harness on their own.
 */
async function collectLocalModels(baseUrl: string): Promise<OllamaModel[]> {
  if (!baseUrl) return []
  return fetchOllamaModels(baseUrl).catch(() => [])
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

/** The local half of `withSelected` — same reason, one flat list. */
function withSelectedLocal(
  models: OllamaModel[],
  selected: { source: string; model: string }
): OllamaModel[] {
  if (selected.source !== OLLAMA_SOURCE) return models
  if (models.some((model) => model.id === selected.model)) return models
  return [...models, { id: selected.model, name: selected.model }]
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
 * `<provider>/<model>` addressing matches this app's composite ids. A source
 * that is not configured is left out entirely rather than written as an empty
 * entry — an unset local URL would otherwise become a `/v1` pi keeps retrying.
 *
 * Ollama's `apiKey` is a placeholder it ignores — pi hides models it considers
 * unauthenticated, so a dummy value is what makes them selectable, and a
 * keyless custom endpoint gets the same treatment.
 *
 * The `compat` flags are per source, not global: what they turn off is what
 * *Ollama's* OpenAI shim rejects — the `developer` role and `reasoning_effort`.
 * A hosted provider is the opposite case (DeepSeek, OpenAI and the rest read
 * `reasoning_effort`), so declaring it unsupported there would silently throw
 * away the effort the composer's picker just set.
 */
async function writeModelsConfig(
  configDir: string,
  baseUrl: string,
  models: OllamaModel[],
  sources: SourceModels[]
) {
  const config: ModelsConfig = {
    providers: {
      ...(baseUrl
        ? {
            ollama: {
              baseUrl: `${baseUrl}/v1`,
              api: "openai-completions",
              apiKey: "ollama",
              compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
              },
              models: models.map((model) => ({
                id: model.id,
                name: model.name,
              })),
            },
          }
        : null),
      ...Object.fromEntries(
        sources.map(({ source, models: listed }) => [
          source.slug,
          {
            baseUrl: source.baseUrl,
            api: "openai-completions",
            apiKey: source.apiKey || "placeholder",
            compat: {
              supportsDeveloperRole: true,
              supportsReasoningEffort: true,
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
  // Owner-only: this overlay carries every hosted source's API key.
  // (Both modes are advisory on Windows, which has no POSIX bits.)
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  await writeFile(path, serialized, { encoding: "utf8", mode: 0o600 })
}
