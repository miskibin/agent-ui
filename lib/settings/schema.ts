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

export type AppSettings = {
  appearance: AppearanceSettings
  providers: ProviderSettings
  chat: ChatSettings
  files: FileSettings
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

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: {
    theme: "modern-minimal",
    mode: "system",
    radiusOverride: null,
    // The themes disagree about the UI face; the app does not have to. This
    // is the one people recognise, and every theme still keeps its palette.
    fontSans: "chatgpt",
    fontMono: FOLLOW_THEME,
  },
  providers: {
    active: "mock",
    ollama: { enabled: true, baseUrl: "http://localhost:11434" },
    pi: { enabled: true, binPath: "", workspace: "" },
    cursorAgent: { enabled: true, binPath: "" },
    mock: { enabled: true },
    acp: { agents: { dsh: DEFAULT_DSH_AGENT } },
  },
  chat: {
    defaultModel: "",
    defaultEffort: "high",
    showSuggestions: true,
    autoTitle: true,
  },
  files: {
    anyPath: true,
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
      mock: {
        ...DEFAULT_SETTINGS.providers.mock,
        ...asObject(asObject(value.providers).mock),
      },
      acp: {
        agents: normalizeAcpAgents(asObject(asObject(value.providers).acp).agents),
      },
    },
    chat: { ...DEFAULT_SETTINGS.chat, ...asObject(value.chat) },
    files: {
      anyPath: asObject(value.files).anyPath !== false,
    },
    recentFolders: asFolderList(value.recentFolders),
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
