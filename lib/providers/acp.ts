import "server-only"
import { ensureOllama } from "@/lib/providers/ollama-autostart"

import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { ModelOption } from "@/components/ui/model-picker"
import { acpConfigDir, hasAcpBinary } from "@/lib/acp-runtime"
import {
  ACP_ERROR,
  AcpRpcError,
  type AcpAgentCapabilities,
  type AcpConfigOption,
} from "@/lib/acp-types"
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
import type {
  AcpAgentSettings,
  DshSandboxMode,
} from "@/lib/settings/schema"
import { hasDeepSeekCredentials } from "@/lib/providers/acp-availability"
import { withPromptContext } from "@/lib/providers/system-prefix"
import type {
  AskUser,
  UserRequest,
  UserRequestOption,
} from "@/lib/turn-requests"
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  PermissionMode,
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

/**
 * Permission modes offered per agent kind. Only dsh has a sandbox that can
 * hold an agent to *writes inside the workspace*, so it is the only one that
 * can honestly offer `edits`: for a generic ACP agent the same choice would be
 * indistinguishable from `full`.
 */
const ACP_PERMISSION_MODES: PermissionMode[] = ["read-only", "full"]
const DSH_PERMISSION_MODES: PermissionMode[] = ["read-only", "edits", "full"]

const MODEL_CACHE_MS = 5 * 60 * 1000
type ModelCacheEntry = { at: number; models: ModelOption[]; raw: Map<string, string> }
const modelCache = new Map<string, ModelCacheEntry>()

/**
 * What each agent said it accepts beside text, learned from the one `initialize`
 * the model probe already pays for. It is kept apart from `modelCache` and
 * never expires: an installed binary's prompt capabilities are a property of
 * the binary, not of a five-minute window, and `info()` must not spawn a
 * process just to answer whether the picker may offer an image button.
 */
const promptCapsCache = new Map<
  string,
  AcpAgentCapabilities["promptCapabilities"]
>()

/** Whether this agent has *told us* it takes images. Unknown reads as no. */
function acceptsImages(id: string): boolean {
  return promptCapsCache.get(id)?.image === true
}

export function createAcpProvider(
  key: string,
  agent: AcpAgentSettings,
  dataDir: string
): AgentProvider {
  const id = acpProviderId(key)
  const isDsh = agent.kind === "dsh"
  const modes = isDsh ? DSH_PERMISSION_MODES : ACP_PERMISSION_MODES
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

  /**
   * The spawn spec for this agent, regenerating dsh's overlay first.
   *
   * `mode` is the turn's permission override, which for dsh has to be decided
   * here rather than at the ACP layer: its sandbox is set by an environment
   * variable read when the process starts. `cwd` is the chat's own folder when
   * it has one — it beats the single workspace from settings, and because the
   * sandbox is scoped to the process cwd it moves the writable root with it.
   */
  const spawnSpec = async (mode?: PermissionMode, cwd?: string) => {
    const root = cwd || workspace
    if (!isDsh) {
      return {
        command,
        args: agent.args,
        cwd: root,
        env: agent.env,
      }
    }
    const patch = await ensureDshPatch(configDir, baseUrl)
    const sandbox = dshSandbox(mode)
    return {
      command,
      args: [...DSH_ACP_ARGS, ...(patch ? ["--patch", patch] : []), ...agent.args],
      cwd: root,
      env: {
        ...dshEnv(configDir, sandbox ? { ...agent.dsh, sandbox } : agent.dsh),
        ...agent.env,
      },
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
          // `reasoning_effort` is a session config option, and setting one an
          // agent does not publish is already swallowed by `setConfigOption`
          // rather than failing the turn — so the control is offered to every
          // ACP agent and simply does nothing on the ones that ignore it.
          effort: true,
          // Only ever true once the agent has said so on `initialize` — which
          // the model probe below is what discovers. A catalog entry that
          // mentions vision proves nothing about the transport.
          vision: acceptsImages(id),
          permissionModes: modes,
          defaultPermissionMode: configuredMode(agent, isDsh, modes),
        },
        available: false,
      }
      const { available, reason } = detect()
      const configureBinary =
        process.platform === "win32" &&
        agent.enabled &&
        (!command || !hasAcpBinary(command))
      if (!available) {
        return { ...base, unavailableReason: reason, configureBinary }
      }
      // dsh can use its hosted DeepSeek route without the optional Ollama
      // overlay. A configured local URL should not hide that capability when
      // the local server is temporarily unavailable.
      if (
        baseUrl &&
        !hasDeepSeekCredentials(agent) &&
        !(await ensureOllama(baseUrl)) &&
        !(await probeOllama(baseUrl))
      ) {
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
        // throwaway session. Hence the cache. The same handshake is the only
        // place an agent says whether it takes images, so it is remembered too.
        const probed = await probeAcpConfigOptions(spec, label)
        options = probed.options
        promptCapsCache.set(id, probed.promptCapabilities)
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

    /**
     * Image support in ACP is a property of the *agent*, not of the model it
     * happens to be routing to: `promptCapabilities` is published once on
     * `initialize` and applies to every `session/prompt`. So either every
     * listed model takes images or none does.
     */
    async visionModels(): Promise<string[]> {
      if (!acceptsImages(id)) return []
      // `/api/models` lists before it asks, so the cache is warm by now; a
      // cold one means nothing has been probed and there is nothing to claim.
      return (modelCache.get(id)?.models ?? []).map((model) => model.id)
    },

    async *run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
      if (isDsh && baseUrl && options.model?.startsWith("ollama/")) {
        if (!(await ensureOllama(baseUrl)) && !(await probeOllama(baseUrl))) {
          yield { type: "error", message: `Could not start or reach Ollama at ${baseUrl}. Check that Ollama is installed.` }
          return
        }
      }
      // A per-chat folder beats the one workspace from settings — for the
      // spawn cwd and for the root `fs/*` requests are confined to alike.
      const root = options.cwd?.trim()
        ? path.resolve(/*turbopackIgnore: true*/ options.cwd.trim())
        : workspace
      const spec = await spawnSpec(options.permissionMode, root).catch(
        (err: unknown) => err as Error
      )
      if (spec instanceof Error) {
        yield {
          type: "error",
          message: `Could not prepare ${label}: ${spec.message}`,
        }
        return
      }

      /**
       * The approval policy this turn actually runs under.
       *
       * `ask` is the one setting a per-chat override cannot overrule: the
       * point of it is that a human sees every request, and quietly promoting
       * it to auto-approve because the composer says "Full access" would be
       * the opposite of what was configured. The override still applies to the
       * other axis — dsh's sandbox, chosen in `spawnSpec` — so a read-only
       * chat is still a read-only process, it just also asks.
       */
      const configured = agent.permissionMode
      const policy =
        configured === "ask"
          ? "ask"
          : (acpPolicy(options.permissionMode) ?? configured)

      /**
       * `fs/write_text_file` is a write we perform *for* the agent, outside
       * the permission dance, so anything short of auto-approve must not be
       * served one. Under `ask` there is no request to put to the user — the
       * capability is declared in the handshake, once, before the turn — so it
       * follows the chat's own mode instead: a read-only chat gets no writer,
       * anything else does.
       */
      const canWriteFiles =
        policy === "auto-approve" ||
        (policy === "ask" && options.permissionMode !== "read-only")

      /** Unique within the turn; ACP tool-call ids repeat across turns. */
      let requestSeq = 0

      const { runAcpAgent } = await import("@/lib/acp-agent")
      yield* runAcpAgent({
        spawn: spec,
        prompt: withPromptContext(options.prompt, options),
        model: decodeModelId(id, options.model, isDsh),
        effort: options.effort,
        sessionId: options.sessionId,
        label,
        canWriteFiles,
        // Only sent when the agent said it takes them; `runAcpAgent` checks
        // `promptCapabilities.image` again against this turn's own handshake.
        images: acceptsImages(id) ? options.images : undefined,
        askUser: options.askUser,
        signal: options.signal,
        handlers: {
          async readTextFile({ path: requested, line, limit }) {
            const target = scopedPath(root, requested)
            const content = await readFile(/*turbopackIgnore: true*/ target, "utf8").catch(() => {
              throw new AcpRpcError(ACP_ERROR.resourceNotFound, `Cannot read ${requested}`)
            })
            return sliceLines(content, line, limit)
          },
          async writeTextFile({ path: requested, content }) {
            const target = scopedPath(root, requested)
            // ACP requires the client to create the file if it is absent.
            await mkdir(path.dirname(target), { recursive: true })
            await writeFile(target, content, "utf8")
          },
          decidePermission({ toolCall, options: choices, ask }) {
            return decide(policy, toolCall, choices, ask, () => ++requestSeq)
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
 * The app's per-chat mode → the ACP approval policy for this turn. `edits` and
 * `full` both auto-approve at the protocol level; what separates them is the
 * sandbox the agent runs *inside*, which only dsh has (see `dshSandbox`).
 *
 * Returns null when the turn carried no override, which leaves the agent's
 * configured policy — including `reject-all`, a setting the picker cannot
 * express — exactly as it was.
 */
function acpPolicy(
  mode: PermissionMode | undefined
): AcpAgentSettings["permissionMode"] | null {
  switch (mode) {
    case "read-only":
      return "auto-approve-reads"
    case "edits":
    case "full":
      return "auto-approve"
    default:
      return null
  }
}

/** The same mode as dsh's own sandbox level, or null for no override. */
function dshSandbox(mode: PermissionMode | undefined): DshSandboxMode | null {
  switch (mode) {
    case "read-only":
      return "read-only"
    case "edits":
      return "workspace-write"
    case "full":
      return "danger-full-access"
    default:
      return null
  }
}

/** The app's modes, narrow → wide, so two different axes can be compared. */
const MODE_RANK: Record<PermissionMode, number> = {
  "read-only": 0,
  // Read-only plus an obligation to write the plan down — nothing an ACP
  // policy or a sandbox level can express, so no agent here ever publishes it.
  plan: 1,
  edits: 2,
  full: 3,
}

/**
 * A configured ACP approval policy, read back as one of the app's modes.
 *
 * `reject-all` approves strictly less than `read-only` does — the picker has
 * no mode for "refuses everything" — so it reads as the narrowest one there
 * is. `ask` sits at the other end: nothing is refused in advance, so its
 * ceiling is whatever the user approves, which is `full` (still clamped by
 * dsh's sandbox below). This is only ever used to label a default, never to
 * send one back.
 */
function policyAsMode(policy: AcpAgentSettings["permissionMode"]): PermissionMode {
  return policy === "auto-approve" || policy === "ask" ? "full" : "read-only"
}

/** A configured dsh sandbox level, read back as one of the app's modes. */
function sandboxAsMode(sandbox: DshSandboxMode): PermissionMode {
  switch (sandbox) {
    case "read-only":
      return "read-only"
    case "workspace-write":
      return "edits"
    default:
      return "full"
  }
}

/**
 * What this agent already runs under, for the composer to show on a chat that
 * has chosen nothing: the *narrower* of the two axes that constrain it — the
 * approval policy, and for dsh the sandbox its process is spawned into.
 *
 * Display only. An unchosen mode is never sent (`app/page.tsx`), so settings
 * stay in charge either way; this exists so the picker cannot label a stock
 * dsh install "Full access" when its sandbox says `workspace-write`. The
 * answer is clamped to the modes this provider publishes, and never widened
 * past the real policy.
 */
function configuredMode(
  agent: AcpAgentSettings,
  isDsh: boolean,
  modes: PermissionMode[]
): PermissionMode | undefined {
  if (modes.length === 0) return undefined
  let rank = MODE_RANK[policyAsMode(agent.permissionMode)]
  if (isDsh) {
    rank = Math.min(rank, MODE_RANK[sandboxAsMode(agent.dsh.sandbox)])
  }
  const offered = [...modes].sort((a, b) => MODE_RANK[a] - MODE_RANK[b])
  let picked = offered[0]
  for (const mode of offered) {
    if (MODE_RANK[mode] <= rank) picked = mode
  }
  return picked
}

/** Whether a permission option lets the tool call proceed. */
function isAllowKind(kind: string | undefined) {
  return kind === "allow_once" || kind === "allow_always"
}

/**
 * `session/request_permission` is a live subprocess blocked on our answer.
 * Three of the four policies decide from settings alone; `ask` puts the
 * decision to the user over `lib/turn-requests` and waits for it, which is
 * what `ask` (present only when the run has an interactive channel) is.
 */
async function decide(
  mode: AcpAgentSettings["permissionMode"],
  toolCall: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown },
  choices: PermissionChoice[],
  ask: AskUser | undefined,
  nextSeq: () => number
): Promise<{ option: PermissionChoice | null; reason: string; approved?: boolean }> {
  const allow =
    choices.find((choice) => choice.kind === "allow_once") ??
    choices.find((choice) => choice.kind === "allow_always") ??
    null
  const name = toolCall.title || "this tool call"

  if (mode === "ask") {
    // No channel means no user: refusing is the only honest answer, and the
    // row says why rather than silently falling back to a wider policy.
    if (!ask) {
      return {
        option: null,
        reason: `Rejected: this agent asks before every tool call, and this run has no way to reach you.`,
      }
    }
    const answer = await ask(permissionRequest(toolCall, choices, nextSeq()))
    const picked = answer.cancelled
      ? undefined
      : choices.find((choice) => choice.optionId === answer.optionId)
    if (!picked) {
      return { option: null, reason: outcomeLine("You did not allow", name), approved: false }
    }
    const approved = isAllowKind(picked.kind)
    return {
      option: picked,
      approved,
      reason: outcomeLine(PERMISSION_VERBS[picked.kind ?? ""] ?? "You chose", name),
    }
  }
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

/** How each ACP option kind reads back once the user has picked it. */
const PERMISSION_VERBS: Record<string, string> = {
  allow_once: "You allowed",
  allow_always: "You always allow",
  reject_once: "You refused",
  reject_always: "You always refuse",
}

/**
 * The outcome, sized for the row it lands in: the vendored tool card shows an
 * output shorter than 28 characters inline in its collapsed headline and hides
 * anything longer behind the disclosure. A decision the user just made should
 * be readable without a click, so a name that would not fit is dropped rather
 * than the whole line going quiet — the request itself is still in the row.
 */
function outcomeLine(verb: string, name: string) {
  const named = `${verb} ${name}.`
  return named.length < 28 ? named : `${verb} it.`
}

/** ACP's four option kinds, for an agent that named none. */
const PERMISSION_KIND_LABELS: Record<string, string> = {
  allow_once: "Allow once",
  allow_always: "Always allow",
  reject_once: "Reject",
  reject_always: "Always reject",
}

/**
 * One ACP permission request, in the app's own vocabulary. The option ids are
 * the agent's opaque ones and travel back untouched — the form only ever
 * echoes what it was handed.
 */
function permissionRequest(
  toolCall: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown },
  choices: PermissionChoice[],
  seq: number
): UserRequest {
  const name = toolCall.title || "this tool call"
  const options: UserRequestOption[] = []
  for (const choice of choices) {
    if (!choice.optionId) continue
    options.push({
      id: choice.optionId,
      label: choice.name?.trim() || PERMISSION_KIND_LABELS[choice.kind ?? ""] || choice.optionId,
      ...(choice.kind ? { kind: choice.kind } : null),
    })
  }
  const description = describeToolInput(toolCall.rawInput)
  return {
    id: `acp-permission-${seq}-${toolCall.toolCallId || "call"}`,
    kind: "permission",
    title: `Allow ${name}?`,
    ...(description ? { description } : null),
    options,
    tool: { name, ...(toolCall.rawInput === undefined ? null : { input: toolCall.rawInput }) },
  }
}

/**
 * The one line under the question: what the agent is actually about to do.
 *
 * The whole argument object is the wrong thing to show — a write carries the
 * file's entire body — so the fields that answer "what is this?" are tried in
 * order, and the raw JSON is only the last resort. Whatever is dropped here is
 * still in the transcript row, which keeps the request verbatim.
 */
function describeToolInput(rawInput: unknown): string | undefined {
  if (rawInput == null) return undefined
  if (typeof rawInput === "string") return clipLine(rawInput)
  const record = rawInput as Record<string, unknown>
  if (typeof record !== "object" || Array.isArray(rawInput)) {
    return clipLine(safeJson(rawInput))
  }
  const first =
    // dsh explains its own escalations, and its sentence beats every guess.
    text(record.justification) ??
    text(record.description) ??
    text(record.command) ??
    text(record.cmd) ??
    text(record.script) ??
    text(record.path) ??
    text(record.file_path) ??
    text(record.filePath) ??
    text(record.target_file)
  if (first) return clipLine(first)
  const rest = { ...record }
  for (const key of ["content", "new_string", "newText", "old_string", "oldText"]) {
    delete rest[key]
  }
  return clipLine(safeJson(rest))
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function clipLine(value: string | undefined): string | undefined {
  const collapsed = value?.replace(/\s+/g, " ").trim()
  if (!collapsed) return undefined
  return collapsed.length > 300 ? `${collapsed.slice(0, 299)}…` : collapsed
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
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
