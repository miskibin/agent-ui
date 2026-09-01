import "server-only"

import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { ModelOption } from "@/components/ui/model-picker"
import { acpConfigDir, hasAcpBinary } from "@/lib/acp-runtime"
import { ACP_ERROR, AcpRpcError, type AcpConfigOption } from "@/lib/acp-types"
import {
  DSH_ACP_ARGS,
  dshEnv,
  dshModelValue,
  dshPatchPath,
  writeDshPatch,
} from "@/lib/dsh-config"
import {
  fetchOllamaModels,
  normalizeBaseUrl,
  probeOllama,
  type OllamaModel,
} from "@/lib/providers/ollama-api"
import type { AcpAgentSettings } from "@/lib/settings/schema"
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  ProviderInfo,
} from "@/lib/providers/types"

/**
 * Providers for agents that speak the Agent Client Protocol.
 *
 * One `AgentProvider` per configured agent, under a namespaced `acp:<key>` id,
 * so a user can add a second or third ACP agent purely through settings — the
 * registry derives its id list from `settings.providers.acp.agents` rather than
 * from a static const.
 *
 * `lib/acp-agent.ts` owns the subprocess and the JSON-RPC plumbing and is
 * imported lazily, so `child_process` never loads on a request that only lists
 * providers.
 */

export const ACP_PROVIDER_PREFIX = "acp:"

export function acpProviderId(key: string) {
  return `${ACP_PROVIDER_PREFIX}${key}`
}

/** `acp:dsh` → `dsh`; anything else → null. */
export function acpAgentKey(providerId: string): string | null {
  return providerId.startsWith(ACP_PROVIDER_PREFIX)
    ? providerId.slice(ACP_PROVIDER_PREFIX.length)
    : null
}

/** Tool kinds ACP defines as non-mutating, for `auto-approve-reads`. */
const READ_KINDS = new Set(["read", "search", "fetch", "think"])
/**
 * dsh reports every tool as `kind: "other"`, so the policy also matches the
 * raw tool name it puts in `title`.
 */
const READ_TOOL_NAMES =
  /^(read|read_image|view|cat|open|glob|grep|search|find|ls|list|list_[a-z_]*|get_[a-z_]*|web_search|fetch)$/i

const MODEL_CACHE_MS = 5 * 60 * 1000
type ModelCacheEntry = { at: number; models: ModelOption[]; raw: Map<string, string> }
const modelCache = new Map<string, ModelCacheEntry>()

export function createAcpProvider(
  key: string,
  agent: AcpAgentSettings,
  dataDir: string
): AgentProvider {
  const id = acpProviderId(key)
  const isDsh = agent.kind === "dsh"
  const command = agent.command.trim()
  const configDir = acpConfigDir(dataDir, key)
  // The session `cwd` and the root `fs/*` requests are confined to. It is also
  // the directory dsh loads a `.env` from, which the settings page warns about.
  const workspace = path.resolve(/*turbopackIgnore: true*/ agent.workspace.trim() || process.cwd())
  const baseUrl = isDsh ? normalizeBaseUrl(agent.dsh.baseUrl) : ""
  const label = agent.name.trim() || key

  const detect = (): { available: boolean; reason?: string } => {
    if (!agent.enabled) return { available: false, reason: "Disabled in settings" }
    if (!command) return { available: false, reason: "No command configured" }
    if (!hasAcpBinary(command)) {
      return {
        available: false,
        reason: command.includes("/") || command.includes("\\")
          ? `No binary at ${command}`
          : `\`${command}\` not found on PATH`,
      }
    }
    if (isDsh && !baseUrl && !agent.dsh.apiKey.trim() && !process.env.DEEPSEEK_API_KEY) {
      return {
        available: false,
        reason: "Set a DeepSeek API key, or an OpenAI-compatible base URL, in settings",
      }
    }
    return { available: true }
  }

  /** The spawn spec for this agent, regenerating dsh's overlay first. */
  const spawnSpec = async () => {
    if (!isDsh) {
      return {
        command,
        args: agent.args,
        cwd: workspace,
        env: agent.env,
      }
    }
    const patch = await ensureDshPatch(configDir, baseUrl)
    return {
      command,
      args: [...DSH_ACP_ARGS, ...(patch ? ["--patch", patch] : []), ...agent.args],
      cwd: workspace,
      env: { ...dshEnv(configDir, agent.dsh), ...agent.env },
    }
  }

  return {
    async info(): Promise<ProviderInfo> {
      const base: ProviderInfo = {
        id,
        name: label,
        description: isDsh
          ? `DeepSeek Harness over ACP — full tool access in ${workspace}${baseUrl ? ` via ${baseUrl}` : ""}. Answers arrive whole, not token by token.`
          : `ACP agent \`${command || "(unset)"}\` with full tool access in ${workspace}.`,
        capabilities: {
          tools: true,
          // ACP `session/resume` restores context across process restarts, so
          // the chat route never replays history for these.
          resume: true,
          // dsh's own route publishes a `reasoning_effort` config option;
          // OpenAI-compatible routes declare no efforts and the option
          // disappears, so the control would be dead.
          effort: isDsh && !baseUrl,
          vision: false,
        },
        available: false,
      }
      const { available, reason } = detect()
      if (!available) return { ...base, unavailableReason: reason }
      if (baseUrl && !(await probeOllama(baseUrl))) {
        return { ...base, unavailableReason: `No server at ${baseUrl}` }
      }
      return { ...base, available: true }
    },

    async listModels(): Promise<ModelOption[]> {
      const cached = modelCache.get(id)
      if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models

      const spec = await spawnSpec()
      const { probeAcpConfigOptions } = await import("@/lib/acp-agent")
      let options: AcpConfigOption[]
      try {
        // ACP has no model-listing RPC — an agent publishes its selectable
        // settings as `configOptions` on a session, so this costs a spawn and a
        // throwaway session. Hence the cache.
        options = await probeAcpConfigOptions(spec, label)
      } catch (err) {
        // A configured local endpoint is enough to name the models ourselves;
        // otherwise the picker degrades to empty with the error shown.
        const fallback = await ollamaFallbackModels(baseUrl)
        if (fallback.models.length === 0) throw err
        remember(id, fallback)
        return fallback.models
      }

      const models = toModelOptions(options)
      remember(id, models)
      return models.models
    },

    async *run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
      const spec = await spawnSpec().catch((err: unknown) => err as Error)
      if (spec instanceof Error) {
        yield {
          type: "error",
          message: `Could not prepare ${label}: ${spec.message}`,
        }
        return
      }

      const { runAcpAgent } = await import("@/lib/acp-agent")
      yield* runAcpAgent({
        spawn: spec,
        prompt: options.prompt,
        model: decodeModelId(id, options.model, isDsh),
        effort: options.effort,
        sessionId: options.sessionId,
        label,
        signal: options.signal,
        handlers: {
          async readTextFile({ path: requested, line, limit }) {
            const target = scopedPath(workspace, requested)
            const content = await readFile(/*turbopackIgnore: true*/ target, "utf8").catch(() => {
              throw new AcpRpcError(ACP_ERROR.resourceNotFound, `Cannot read ${requested}`)
            })
            return sliceLines(content, line, limit)
          },
          async writeTextFile({ path: requested, content }) {
            const target = scopedPath(workspace, requested)
            // ACP requires the client to create the file if it is absent.
            await mkdir(path.dirname(target), { recursive: true })
            await writeFile(target, content, "utf8")
          },
          decidePermission({ toolCall, options: choices }) {
            return decide(agent.permissionMode, toolCall, choices)
          },
        },
      })
    },
  }
}

/* -------------------------------------------------------------------------- */
/*                              permission policy                             */
/* -------------------------------------------------------------------------- */

type PermissionChoice = { optionId?: string; name?: string; kind?: string }

/**
 * `session/request_permission` is a live subprocess blocked on our answer, and
 * the browser's only way to talk back mid-run is a *new* POST — so v1 answers
 * from a per-agent policy instead. That is the same bar the rest of this app
 * already ships at: `pi` never asks, and `cursorAgent` runs `--trust --force`.
 */
function decide(
  mode: AcpAgentSettings["permissionMode"],
  toolCall: { title?: string; kind?: string },
  choices: PermissionChoice[]
): { option: PermissionChoice | null; reason: string } {
  const allow =
    choices.find((choice) => choice.kind === "allow_once") ??
    choices.find((choice) => choice.kind === "allow_always") ??
    null
  const name = toolCall.title || "this tool call"

  if (mode === "reject-all") {
    return { option: null, reason: `Rejected: the permission policy for this agent is "never allow".` }
  }
  if (mode === "auto-approve") {
    return allow
      ? { option: allow, reason: `Approved automatically (${name}).` }
      : { option: null, reason: `Rejected: the agent offered no allow option.` }
  }
  // auto-approve-reads
  const readOnly =
    READ_KINDS.has(toolCall.kind ?? "") || READ_TOOL_NAMES.test(toolCall.title ?? "")
  if (readOnly && allow) {
    return { option: allow, reason: `Approved automatically — ${name} only reads.` }
  }
  return {
    option: null,
    reason: `Rejected: ${name} is not read-only and this agent only auto-approves reads.`,
  }
}

/* -------------------------------------------------------------------------- */
/*                              workspace scoping                             */
/* -------------------------------------------------------------------------- */

/**
 * Every `fs/*` path an agent sends is resolved against the configured
 * workspace and refused if it escapes — the whole sandbox, and slightly more
 * containment than `pi`'s bash tool has today.
 */
function scopedPath(workspace: string, requested: string): string {
  const root = path.resolve(workspace)
  const resolved = path.resolve(root, requested)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new AcpRpcError(
      ACP_ERROR.invalidParams,
      `Path escapes the workspace: ${requested}`
    )
  }
  return resolved
}

/** `fs/read_text_file` takes an optional 1-based line window. */
function sliceLines(content: string, line?: number, limit?: number): string {
  if (!line && !limit) return content
  const lines = content.split("\n")
  const start = Math.max((line ?? 1) - 1, 0)
  const end = limit ? start + limit : lines.length
  return lines.slice(start, end).join("\n")
}

/* -------------------------------------------------------------------------- */
/*                                   models                                   */
/* -------------------------------------------------------------------------- */

type ModelSet = { models: ModelOption[]; raw: Map<string, string> }

function remember(id: string, set: ModelSet) {
  modelCache.set(id, { at: Date.now(), models: set.models, raw: set.raw })
}

/**
 * Option values are opaque strings the client must echo back verbatim. dsh's
 * are JSON `["provider","model"]` pairs, which would read terribly in the
 * model picker, so they are shown as `provider/model` and translated back on
 * the way out.
 */
function toModelOptions(options: AcpConfigOption[]): ModelSet {
  const models: ModelOption[] = []
  const raw = new Map<string, string>()
  const option = options.find((entry) => entry.id === "model" || entry.category === "model")
  for (const choice of flatten(option)) {
    const id = displayModelId(choice.value)
    raw.set(id, choice.value)
    models.push({
      id,
      name: choice.name,
      ...(choice.group ? { badge: choice.group } : null),
      ...(choice.description ? { description: choice.description } : null),
    })
  }
  return { models, raw }
}

/** Kept out of the module's import graph until a probe actually runs. */
function flatten(option: AcpConfigOption | undefined) {
  const out: Array<{ value: string; name: string; description?: string; group?: string }> = []
  const walk = (choices: AcpConfigOption["options"], group?: string) => {
    for (const choice of choices ?? []) {
      if (Array.isArray(choice.options) && choice.options.length > 0) {
        walk(choice.options, choice.group ?? choice.name ?? group)
        continue
      }
      if (typeof choice.value !== "string") continue
      out.push({
        value: choice.value,
        name: choice.name ?? choice.value,
        description: choice.description,
        group,
      })
    }
  }
  walk(option?.options)
  return out
}

function displayModelId(value: string): string {
  const pair = parsePair(value)
  return pair ? `${pair[0]}/${pair[1]}` : value
}

function parsePair(value: string): [string, string] | null {
  if (!value.startsWith("[")) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0], parsed[1]]
    }
  } catch {
    /* not a pair — an opaque value from some other agent */
  }
  return null
}

/**
 * Back to the exact opaque value: from the last listing when it is still warm,
 * otherwise re-encoded — but only for dsh, the one agent whose encoding we
 * know. Everything else is passed through untouched.
 */
function decodeModelId(id: string, model: string | undefined, isDsh: boolean): string {
  const wanted = model?.trim()
  if (!wanted) return ""
  const known = modelCache.get(id)?.raw.get(wanted)
  if (known) return known
  if (!isDsh) return wanted
  const slash = wanted.indexOf("/")
  return slash > 0
    ? dshModelValue(wanted.slice(0, slash), wanted.slice(slash + 1))
    : wanted
}

/**
 * When the probe fails but a local OpenAI-compatible endpoint is configured, we
 * already know exactly which models the generated overlay declared.
 */
async function ollamaFallbackModels(baseUrl: string): Promise<ModelSet> {
  if (!baseUrl) return { models: [], raw: new Map() }
  let listed: OllamaModel[]
  try {
    listed = await fetchOllamaModels(baseUrl)
  } catch {
    return { models: [], raw: new Map() }
  }
  const models: ModelOption[] = []
  const raw = new Map<string, string>()
  for (const model of listed) {
    const id = `ollama/${model.id}`
    raw.set(id, dshModelValue("ollama", model.id))
    models.push({ id, name: model.name, badge: "Ollama" })
  }
  return { models, raw }
}

/** Regenerates dsh's `--patch` overlay from whatever the endpoint is serving. */
async function ensureDshPatch(
  configDir: string,
  baseUrl: string
): Promise<string | null> {
  if (!baseUrl) return null
  try {
    const models = await fetchOllamaModels(baseUrl)
    return await writeDshPatch(configDir, baseUrl, models)
  } catch {
    // The endpoint is down but a previously written overlay still describes
    // it — better a stale route than none, and the turn's own error will say
    // what actually went wrong.
    const existing = dshPatchPath(configDir)
    return (await readFile(existing, "utf8").catch(() => null)) ? existing : null
  }
}
