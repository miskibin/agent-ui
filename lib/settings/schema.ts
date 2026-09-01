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

export type ProviderSettings = {
  /** Provider id the composer uses by default. */
  active: string
  ollama: OllamaSettings
  pi: PiSettings
  cursorAgent: CursorAgentSettings
  mock: MockSettings
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

/** How many folders the picker remembers. */
export const MAX_RECENT_FOLDERS = 8

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: {
    theme: "modern-minimal",
    mode: "system",
    radiusOverride: null,
  },
  providers: {
    active: "mock",
    ollama: { enabled: true, baseUrl: "http://localhost:11434" },
    pi: { enabled: true, binPath: "", workspace: "" },
    cursorAgent: { enabled: true, binPath: "" },
    mock: { enabled: true },
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
    },
    chat: { ...DEFAULT_SETTINGS.chat, ...asObject(value.chat) },
    files: {
      anyPath: asObject(value.files).anyPath !== false,
    },
    recentFolders: asFolderList(value.recentFolders),
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
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
