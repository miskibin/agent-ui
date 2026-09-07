import "server-only"
import { ensureOllama } from "@/lib/providers/ollama-autostart"

import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { ModelOption } from "@/components/ui/model-picker"
import { joinModelId, splitModelId } from "@/lib/model-providers/ids"
import {
  enabledModelSources,
  listSourceModels,
  type ModelSource,
} from "@/lib/model-providers/server"
import { sniffImageMimeType } from "@/lib/attachments"
import { writePiExtension } from "@/lib/pi-extension"
import { hasPiBinary } from "@/lib/pi-runtime"
import { withPromptContext } from "@/lib/providers/system-prefix"
import {
  fetchOllamaContextLengths,
  fetchOllamaModels,
  fetchVisionCapableModelIds,
  looksVisionCapableId,
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
        description: `Agentic harness over ${sourceSummary(baseUrl, sources)} — read, write, edit, bash, ask.`,
        capabilities: {
          tools: true,
          // pi keeps the transcript in its own session file on disk.
          resume: true,
          // Maps straight onto pi's `--thinking` levels.
          effort: true,
          // Transport-level: the RPC `prompt` command carries images. Which
          // *models* look at them is a per-model question, answered by
          // `visionModels()` below — and by the `input` the generated
          // models.json gives each one, without which pi drops them silently.
          vision: true,
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
      if (sources.length > 0) return { ...base, available: true }
      if (baseUrl && ((await ensureOllama(baseUrl)) || (await probeOllama(baseUrl)))) {
        return { ...base, available: true }
      }
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
      await writeModelsConfig(
        configDir,
        baseUrl,
        models,
        remote,
        await localVisionIds(baseUrl, models)
      )
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

    /**
     * Which of the picker's ids actually take an image, in the app's composite
     * spelling. Two different qualities of evidence, deliberately kept apart:
     * a local model is asked (`/api/show` reports `vision` outright), while a
     * hosted one can only be read off its id, because no OpenAI-compatible
     * `/models` says anything about modality. The same split decides the
     * `input` written into models.json, so what the composer offers and what
     * pi will actually forward can never drift.
     */
    async visionModels() {
      const [models, remote] = await Promise.all([
        collectLocalModels(baseUrl),
        collectSourceModels(sources),
      ])
      const local = await localVisionIds(baseUrl, models)
      return [
        ...[...local].map((id) => joinModelId(OLLAMA_SOURCE, id)),
        ...remote.flatMap(({ source, models: listed }) =>
          listed
            .filter((model) => looksVisionCapableId(model.id))
            .map((model) => joinModelId(source.slug, model.id))
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
      let extensionPath: string | undefined
      try {
        // Listed together: one unreachable source must not add its whole
        // timeout to the wait before the first token.
        const [models, remote] = await Promise.all([
          collectLocalModels(baseUrl),
          collectSourceModels(sources),
        ])
        const local = withSelectedLocal(models, selected)
        await writeModelsConfig(
          configDir,
          baseUrl,
          // Same reason as the hosted sources below: a local server that did
          // not answer must not cost the picked tag its catalog entry.
          local,
          // A source whose catalog could not be listed would otherwise leave
          // pi unable to resolve the very model that was picked from it.
          withSelected(remote, selected),
          await localVisionIds(baseUrl, local)
        )
        extensionPath = await writePiExtension(configDir)
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
        extensionPath,
        // The media type is gone by the time a payload reaches a provider —
        // `AgentRunOptions.images` is raw base64 — and pi's RPC `images` want
        // one, so it is read back off the bytes.
        images: options.images?.map((data) => ({
          type: "image" as const,
          data,
          mimeType: sniffImageMimeType(data),
        })),
        askUser: options.askUser,
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
      models: Array<{ id: string; name: string; input?: string[] }>
    }
  >
}

/** pi's own spelling of "this model takes pictures", and its default. */
const TEXT_ONLY = ["text"]
const TEXT_AND_IMAGE = ["text", "image"]

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
 * Which local tags take an image, straight from the server. Best-effort like
 * everything else that talks to it — a probe that fails leaves a model out,
 * which costs it the attachment button rather than the whole turn. The
 * `/api/show` reads behind this are memoized per model, so the picker's sweep
 * and the one a run does moments later are a single round of requests.
 */
async function localVisionIds(
  baseUrl: string,
  models: OllamaModel[]
): Promise<Set<string>> {
  if (!baseUrl || models.length === 0) return new Set()
  const ids = await fetchVisionCapableModelIds(baseUrl, models).catch(() => [])
  return new Set(ids)
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
 *
 * `input` is written for the same reason and matters just as much: it defaults
 * to `["text"]`, and a model left at the default has the images dropped from
 * the request without a word — the run reads as a model that looked and did
 * not see. It is the same judgement `visionModels()` publishes to the
 * composer, so a model that offers the attachment button is a model whose
 * catalog entry will carry the picture.
 */
async function writeModelsConfig(
  configDir: string,
  baseUrl: string,
  models: OllamaModel[],
  sources: SourceModels[],
  localVision: Set<string>
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
                input: localVision.has(model.id) ? TEXT_AND_IMAGE : TEXT_ONLY,
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
            models: listed.map((model) => ({
              id: model.id,
              name: model.name,
              input: looksVisionCapableId(model.id) ? TEXT_AND_IMAGE : TEXT_ONLY,
            })),
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
  // A concurrent turn may spawn a pi that reads this file at any moment, so it
  // is replaced rather than rewritten: a reader sees the whole old file or the
  // whole new one, never a half-written one.
  const tmp = `${path}.${process.pid.toString(36)}${randomBytes(3).toString("hex")}.tmp`
  await writeFile(tmp, serialized, { encoding: "utf8", mode: 0o600 })
  await rename(tmp, path)
}
