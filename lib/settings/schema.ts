import {
  MODEL_PROVIDER_PRESETS,
  MODEL_PROVIDER_SLUG_RE,
  RESERVED_MODEL_PROVIDER_SLUGS,
} from "@/lib/model-providers/presets"
import type { PermissionMode } from "@/lib/providers/types"
import {
  DEFAULT_CONTRAST,
  isContrastLevel,
  type ContrastLevel,
} from "@/lib/theme/contrast"
import {
  FOLLOW_THEME,
  findFont,
  type FontRole,
} from "@/lib/theme/font-options"

/**
 * App settings shared by the settings page (writes) and the chat/provider
 * layer (reads). Persisted as JSON in ~/.agent-ui/settings.json via
 * `lib/settings/server`. Keep every field optional-with-default so old
 * settings files keep loading after upgrades.
 */

export type ThemeMode = "light" | "dark" | "system"

export type AppearanceSettings = {
  /** Theme preset id — the presets themselves live in the theme registry. */
  theme: string
  mode: ThemeMode
  /**
   * How hard the theme's own tokens are pushed apart. `standard` holds every
   * text pair to WCAG AA, `high` to AAA, `soft` relaxes the greys (with a
   * floor). It is a *level*, not a palette: see `lib/theme/contrast.ts`.
   */
  contrast: ContrastLevel
  /**
   * Corner radius in rem, overriding the one the theme ships with.
   * `null` (the default) means "follow the theme" — which is why the pre-0.2
   * `radius` field is deliberately not migrated: it would pin every theme to
   * one rounding.
   */
  radiusOverride: number | null
  /**
   * Typeface ids from `lib/theme/font-options`, overriding the ones the theme
   * ships with. `""` (`FOLLOW_THEME`) hands the choice back to the preset.
   */
  fontSans: string
  fontMono: string
  /**
   * Interface scale, 1 = 100%. Stepped with Ctrl/⌘ + and −, reset with
   * Ctrl/⌘ 0, and exposed as a slider in Settings → Appearance.
   */
  zoom: number
}

export type OllamaSettings = {
  enabled: boolean
  baseUrl: string
}

export type PiSettings = {
  enabled: boolean
  /** Absolute path to the `pi` binary; empty = autodetect on PATH. */
  binPath: string
  /** Directory the agent may read and write; empty = the app's cwd. */
  workspace: string
}

export type CursorAgentSettings = {
  enabled: boolean
  /** Absolute path override; empty = autodetect on PATH. */
  binPath: string
}

export type ClaudeCodeSettings = {
  enabled: boolean
  /** Absolute path to the `claude` binary; empty = autodetect on PATH. */
  binPath: string
  /** Directory the agent may read and write; empty = the app's cwd. */
  workspace: string
  /**
   * What a turn may do when the chat has not picked a mode of its own. Unlike
   * the other harnesses this one can enforce all three, so the default is a
   * real safety setting rather than a label.
   */
  permissionMode: PermissionMode
}

export type MockSettings = {
  enabled: boolean
}

/**
 * What we answer an ACP agent's `session/request_permission` with. The turn is
 * a live subprocess blocked on our reply, and the browser's only channel back
 * is a *new* POST, so v1 decides from this policy instead of asking the user
 * mid-run — the same stance `pi` (no prompt at all) and `cursorAgent`
 * (`--trust --force`) already ship with.
 */
export type AcpPermissionMode =
  | "auto-approve"
  | "auto-approve-reads"
  | "reject-all"

/** dsh's own sandbox + approval policy, passed as `DSH_PERMISSION_MODE`. */
export type DshSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access"

/**
 * Extra knobs only the built-in `dsh` entry uses. An OpenAI-compatible
 * `baseUrl` (Ollama, say) is wired in through a generated `--patch` overlay;
 * leaving it empty falls back to DeepSeek's own hosted route, which reads
 * `apiKey` (or an inherited `DEEPSEEK_API_KEY`).
 */
export type DshSettings = {
  baseUrl: string
  apiKey: string
  sandbox: DshSandboxMode
}

export type AcpAgentSettings = {
  enabled: boolean
  /** Display name in the provider picker. */
  name: string
  /** `dsh` gets the generated config + `--profile acp`; `generic` is spawned as configured. */
  kind: "dsh" | "generic"
  /** Command to spawn — an absolute path, or a name resolved on PATH. */
  command: string
  args: string[]
  env: Record<string, string>
  /** Session `cwd`, and the root `fs/*` requests are confined to; empty = the app's cwd. */
  workspace: string
  permissionMode: AcpPermissionMode
  dsh: DshSettings
}

export type AcpSettings = {
  /** Keyed by a slug that becomes the `acp:<key>` provider id. */
  agents: Record<string, AcpAgentSettings>
}

export type ProviderSettings = {
  /** Provider id the composer uses by default. */
  active: string
  ollama: OllamaSettings
  pi: PiSettings
  cursorAgent: CursorAgentSettings
  claudeCode: ClaudeCodeSettings
  mock: MockSettings
  acp: AcpSettings
}

export type ChatSettings = {
  /** Model id preselected for new chats; empty = provider default. */
  defaultModel: string
  /** Effort id from DEFAULT_MODEL_EFFORTS; empty = hidden. */
  defaultEffort: string
  showSuggestions: boolean
  /** Titles for new chats are derived from the first prompt when true. */
  autoTitle: boolean
  /** Play a cue when a run finishes or pauses for an answer. */
  notificationSounds: boolean
  /**
   * Post an OS notification when a run finishes or pauses for an answer while
   * the window is not in front. The sound above is for when you are looking;
   * this is for when you are not.
   */
  desktopNotifications: boolean
}

/**
 * Where "open" goes. Editors are detected on the machine the server runs on
 * (`lib/open-target`); `defaultEditor` names one of them by id, and "" means
 * the first one found. `terminal` works the same way for "Open in terminal".
 */
export type EditorSettings = {
  defaultEditor: string
  terminal: string
}

export type FileSettings = {
  /**
   * Whether `GET /api/files` serves any absolute path on this machine, which
   * is what lets an answer show an image it wrote anywhere on disk. Turning it
   * off narrows the route to the app's data directory, the folders chats are
   * pointed at, and the agent workspace — the places the app already works in.
   *
   * On is the default: this is a local-first app talking to a local agent, and
   * the paths come from the answer, so the switch is here for anyone who would
   * rather the route could not read `~/.ssh` on a bad answer's say-so.
   */
  anyPath: boolean
}

/**
 * The optional user memory layer (`lib/memory`). Off by default and on its own
 * switch: it is the one feature here that carries something learned in one
 * conversation into every later one, including conversations with a different
 * backend, so it is never something a user ends up with by accident.
 */
export type MemorySettings = {
  enabled: boolean
  /** Ollama model id that runs the extraction; empty = the feature is inert. */
  model: string
  /** Run an extraction pass after every turn, rather than only on demand. */
  autoUpdate: boolean
  /**
   * Whether health, ethnicity, religion, politics and gender identity may be
   * remembered. Off by default, and the extractor is told to skip them as well
   * as filtered afterwards — a fact this specific about a person should take a
   * deliberate act to store, not a passing mention.
   */
  includeSensitive: boolean
  /** Character budget for the whole store; going over triggers a merge pass. */
  maxChars: number
}

/**
 * The per-chat agent handoff (`lib/handoff`). On by default, unlike memory:
 * nothing here leaves the chat it was collected in, nothing is written to a
 * durable store, and the block it produces describes only what other agents
 * already did in the very conversation the user is looking at.
 *
 * Deliberately one switch and no knobs. It is not a second memory: memory is
 * durable, cross-chat and about the user; this is ephemeral, single-chat and
 * about the other agents.
 */
export type HandoffSettings = {
  enabled: boolean
}

/**
 * One OpenAI-compatible model source, keyed in `modelProviders` by a slug that
 * becomes the `<slug>/<model>` prefix of every composite model id it serves.
 * Every preset ships disabled and keyless: a provider only appears in the
 * pickers once someone has actually configured it.
 */
export type ModelProviderEntry = {
  enabled: boolean
  /** Display name in pickers and settings. */
  name: string
  /** OpenAI-compatible base URL ending in the version segment, no trailing slash. */
  baseUrl: string
  apiKey: string
  /** Manual model ids; empty = fetch `${baseUrl}/models`. */
  models: string[]
}

export type AppSettings = {
  appearance: AppearanceSettings
  providers: ProviderSettings
  /**
   * Hosted model sources, keyed by slug. Separate from `providers` because
   * these are *models* behind one shared OpenAI-compatible protocol, not
   * separate agent backends with their own streaming, resume and tool
   * semantics.
   */
  modelProviders: Record<string, ModelProviderEntry>
  chat: ChatSettings
  files: FileSettings
  editor: EditorSettings
  memory: MemorySettings
  handoff: HandoffSettings
  /** Most-recently used working folders, newest first — the folder picker's list. */
  recentFolders: string[]
}

/**
 * The one ACP agent that ships configured. Listed like `pi`/`cursorAgent` even
 * when the binary is missing, so the picker can say *why* it is greyed out.
 * ACP support lives only on dsh's npm `alpha` tag:
 * `npm i -g --ignore-scripts @deepseek-ai/dsh@0.1.2-alpha.3`.
 */
export const DEFAULT_DSH_AGENT: AcpAgentSettings = {
  enabled: true,
  name: "DeepSeek Harness",
  kind: "dsh",
  command: "dsh",
  args: [],
  env: {},
  workspace: "",
  permissionMode: "auto-approve",
  dsh: { baseUrl: "", apiKey: "", sandbox: "workspace-write" },
}

/** How many folders the picker remembers. */
export const MAX_RECENT_FOLDERS = 8

/** Every shipped preset, disabled and keyless — see `ModelProviderEntry`. */
function defaultModelProviders(): Record<string, ModelProviderEntry> {
  const entries: Record<string, ModelProviderEntry> = {}
  for (const preset of MODEL_PROVIDER_PRESETS) {
    entries[preset.slug] = {
      enabled: false,
      name: preset.name,
      baseUrl: preset.baseUrl,
      apiKey: "",
      models: [],
    }
  }
  return entries
}

/**
 * Characters of memory handed to a turn. Small on purpose: at this size every
 * fact fits in the prompt, so the feature needs no retrieval step, no
 * embeddings and no ranking — and the budget is what forces the extractor to
 * merge rather than accrete.
 */
export const DEFAULT_MEMORY_BUDGET = 2_000
export const MEMORY_BUDGET_RANGE = { min: 500, max: 8_000 } as const

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: {
    theme: "modern-minimal",
    mode: "system",
    contrast: DEFAULT_CONTRAST,
    radiusOverride: null,
    // The themes disagree about the UI face; the app does not have to. This
    // is the one people recognise, and every theme still keeps its palette.
    fontSans: "chatgpt",
    fontMono: FOLLOW_THEME,
    zoom: 1,
  },
  providers: {
    active: "mock",
    ollama: { enabled: true, baseUrl: "http://localhost:11434" },
    pi: { enabled: true, binPath: "", workspace: "" },
    cursorAgent: { enabled: true, binPath: "" },
    claudeCode: {
      enabled: true,
      binPath: "",
      workspace: "",
      // The harness can enforce all three, so the shipped default is the
      // middle one: files yes, arbitrary shell only when a chat asks for it.
      permissionMode: "edits",
    },
    mock: { enabled: true },
    acp: { agents: { dsh: DEFAULT_DSH_AGENT } },
  },
  modelProviders: defaultModelProviders(),
  chat: {
    defaultModel: "",
    defaultEffort: "high",
    showSuggestions: true,
    autoTitle: true,
    notificationSounds: true,
    desktopNotifications: true,
  },
  files: {
    anyPath: true,
  },
  editor: {
    defaultEditor: "",
    terminal: "",
  },
  memory: {
    enabled: false,
    model: "",
    autoUpdate: true,
    includeSensitive: false,
    maxChars: DEFAULT_MEMORY_BUDGET,
  },
  handoff: {
    enabled: true,
  },
  recentFolders: [],
}

/** Deep-merges a possibly stale/partial persisted value over the defaults. */
export function normalizeSettings(raw: unknown): AppSettings {
  const value = (raw ?? {}) as Partial<Record<keyof AppSettings, unknown>>
  const appearance = asObject(value.appearance)
  return {
    appearance: {
      theme:
        typeof appearance.theme === "string"
          ? appearance.theme
          : DEFAULT_SETTINGS.appearance.theme,
      mode: isMode(appearance.mode)
        ? appearance.mode
        : DEFAULT_SETTINGS.appearance.mode,
      contrast: isContrastLevel(appearance.contrast)
        ? appearance.contrast
        : DEFAULT_SETTINGS.appearance.contrast,
      // Pre-0.2 files carry a plain `radius`; dropping it hands the themes
      // back their own rounding instead of freezing the old slider value.
      radiusOverride:
        typeof appearance.radiusOverride === "number" &&
        Number.isFinite(appearance.radiusOverride)
          ? appearance.radiusOverride
          : null,
      fontSans: asFontId(
        "sans",
        appearance.fontSans,
        DEFAULT_SETTINGS.appearance.fontSans
      ),
      fontMono: asFontId(
        "mono",
        appearance.fontMono,
        DEFAULT_SETTINGS.appearance.fontMono
      ),
      zoom: asZoom(appearance.zoom),
    },
    providers: {
      ...DEFAULT_SETTINGS.providers,
      ...asObject(value.providers),
      ollama: {
        ...DEFAULT_SETTINGS.providers.ollama,
        ...asObject(asObject(value.providers).ollama),
      },
      pi: {
        ...DEFAULT_SETTINGS.providers.pi,
        ...asObject(asObject(value.providers).pi),
      },
      cursorAgent: {
        ...DEFAULT_SETTINGS.providers.cursorAgent,
        ...asObject(asObject(value.providers).cursorAgent),
      },
      claudeCode: normalizeClaudeCode(asObject(value.providers).claudeCode),
      mock: {
        ...DEFAULT_SETTINGS.providers.mock,
        ...asObject(asObject(value.providers).mock),
      },
      acp: {
        agents: normalizeAcpAgents(asObject(asObject(value.providers).acp).agents),
      },
    },
    modelProviders: normalizeModelProviders(value.modelProviders),
    chat: { ...DEFAULT_SETTINGS.chat, ...asObject(value.chat) },
    files: {
      anyPath: asObject(value.files).anyPath !== false,
    },
    editor: {
      defaultEditor:
        asString(asObject(value.editor).defaultEditor) ??
        DEFAULT_SETTINGS.editor.defaultEditor,
      terminal:
        asString(asObject(value.editor).terminal) ??
        DEFAULT_SETTINGS.editor.terminal,
    },
    memory: normalizeMemory(value.memory),
    handoff: {
      enabled: asObject(value.handoff).enabled !== false,
    },
    recentFolders: asFolderList(value.recentFolders),
  }
}

const PERMISSION_MODES = new Set<PermissionMode>(["read-only", "edits", "full"])

/**
 * The mode becomes CLI permission flags, so a value an older build or a
 * hand-edited file left behind falls back to the default rather than being
 * passed through to `--permission-mode` as-is.
 */
function normalizeClaudeCode(raw: unknown): ClaudeCodeSettings {
  const fallback = DEFAULT_SETTINGS.providers.claudeCode
  const merged = { ...fallback, ...asObject(raw) }
  return {
    ...merged,
    permissionMode: PERMISSION_MODES.has(merged.permissionMode as PermissionMode)
      ? (merged.permissionMode as PermissionMode)
      : fallback.permissionMode,
  }
}

const ACP_PERMISSION_MODES: AcpPermissionMode[] = [
  "auto-approve",
  "auto-approve-reads",
  "reject-all",
]
const DSH_SANDBOX_MODES: DshSandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
]

/**
 * The one open-ended dictionary in the settings file: built-in agents are
 * merged over their defaults (so a settings.json predating ACP still gains the
 * `dsh` entry), and user-added ones are validated field by field because there
 * is no default to fall back on.
 */
function normalizeAcpAgents(raw: unknown): Record<string, AcpAgentSettings> {
  const defaults = DEFAULT_SETTINGS.providers.acp.agents
  const stored = asObject(raw)
  const merged: Record<string, AcpAgentSettings> = {}
  for (const [id, fallback] of Object.entries(defaults)) {
    merged[id] = normalizeAcpAgent(stored[id], fallback)
  }
  for (const [id, entry] of Object.entries(stored)) {
    if (id in merged) continue
    merged[id] = normalizeAcpAgent(entry, { ...DEFAULT_DSH_AGENT, name: id, kind: "generic", command: "" })
  }
  return merged
}

function normalizeAcpAgent(
  raw: unknown,
  fallback: AcpAgentSettings
): AcpAgentSettings {
  const value = asObject(raw)
  const dsh = asObject(value.dsh)
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : fallback.enabled,
    name: asString(value.name) ?? fallback.name,
    kind: value.kind === "dsh" || value.kind === "generic" ? value.kind : fallback.kind,
    command: asString(value.command) ?? fallback.command,
    args: Array.isArray(value.args)
      ? value.args.filter((arg): arg is string => typeof arg === "string")
      : fallback.args,
    env: asStringRecord(value.env) ?? fallback.env,
    workspace: asString(value.workspace) ?? fallback.workspace,
    permissionMode: ACP_PERMISSION_MODES.includes(value.permissionMode as AcpPermissionMode)
      ? (value.permissionMode as AcpPermissionMode)
      : fallback.permissionMode,
    dsh: {
      baseUrl: asString(dsh.baseUrl) ?? fallback.dsh.baseUrl,
      apiKey: asString(dsh.apiKey) ?? fallback.dsh.apiKey,
      sandbox: DSH_SANDBOX_MODES.includes(dsh.sandbox as DshSandboxMode)
        ? (dsh.sandbox as DshSandboxMode)
        : fallback.dsh.sandbox,
    },
  }
}

/**
 * Same shape of merge as `normalizeAcpAgents`: presets are merged over their
 * defaults, so a settings.json written before a preset existed still gains it
 * (disabled, with the current base URL), and user-added sources are validated
 * field by field.
 *
 * Two keys never survive: a slug outside the separator-free alphabet, because
 * it would become a `<slug>/<model>` prefix that no longer round-trips, and a
 * reserved one, because `ollama` already names the local source.
 */
function normalizeModelProviders(raw: unknown): Record<string, ModelProviderEntry> {
  const defaults = DEFAULT_SETTINGS.modelProviders
  const stored = asObject(raw)
  const merged: Record<string, ModelProviderEntry> = {}
  for (const [slug, fallback] of Object.entries(defaults)) {
    merged[slug] = normalizeModelProvider(stored[slug], fallback)
  }
  for (const [slug, entry] of Object.entries(stored)) {
    if (slug in merged) continue
    if (!MODEL_PROVIDER_SLUG_RE.test(slug)) continue
    if (RESERVED_MODEL_PROVIDER_SLUGS.includes(slug)) continue
    merged[slug] = normalizeModelProvider(entry, {
      enabled: false,
      name: slug,
      baseUrl: "",
      apiKey: "",
      models: [],
    })
  }
  return merged
}

function normalizeModelProvider(
  raw: unknown,
  fallback: ModelProviderEntry
): ModelProviderEntry {
  const value = asObject(raw)
  const baseUrl = asString(value.baseUrl)
  return {
    enabled: value.enabled === true,
    name: asString(value.name)?.trim() || fallback.name,
    // Kept trailing-slash-free: every caller joins `/models` or
    // `/chat/completions` onto this.
    baseUrl:
      baseUrl === undefined
        ? fallback.baseUrl
        : baseUrl.trim().replace(/\/+$/, ""),
    apiKey: asString(value.apiKey)?.trim() ?? fallback.apiKey,
    models: Array.isArray(value.models)
      ? asModelIdList(value.models)
      : fallback.models,
  }
}

/** Trimmed, de-duplicated, order preserved — this is a hand-typed list. */
function asModelIdList(value: unknown[]): string[] {
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== "string") continue
    const id = entry.trim()
    if (id) seen.add(id)
  }
  return [...seen]
}

/**
 * Every field falls back to the default, and `enabled` must be exactly `true`
 * — a settings file predating this feature, or one with a garbled value, ends
 * up with memory off rather than quietly on.
 */
function normalizeMemory(raw: unknown): MemorySettings {
  const fallback = DEFAULT_SETTINGS.memory
  const value = asObject(raw)
  const budget =
    typeof value.maxChars === "number" && Number.isFinite(value.maxChars)
      ? Math.min(
          MEMORY_BUDGET_RANGE.max,
          Math.max(MEMORY_BUDGET_RANGE.min, Math.round(value.maxChars))
        )
      : fallback.maxChars
  return {
    enabled: value.enabled === true,
    model: asString(value.model)?.trim() ?? fallback.model,
    autoUpdate: value.autoUpdate !== false,
    includeSensitive: value.includeSensitive === true,
    maxChars: budget,
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry
  }
  return out
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * A field that is not there at all means "never chosen", which is the app's
 * default — not `FOLLOW_THEME`, and not a reason to throw the file away. An
 * id that *is* there but no longer exists resolves to following the theme.
 */
function asFontId(role: FontRole, value: unknown, fallback: string): string {
  return typeof value === "string" ? findFont(role, value).id : fallback
}

function isMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system"
}

function asZoom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.appearance.zoom
  }
  return Math.min(2, Math.max(0.5, Math.round(value * 10) / 10))
}

/** Trimmed, de-duplicated, newest first, capped. */
function asFolderList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== "string") continue
    const path = entry.trim()
    if (path) seen.add(path)
    if (seen.size >= MAX_RECENT_FOLDERS) break
  }
  return [...seen]
}
