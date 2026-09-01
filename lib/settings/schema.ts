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

export type AppSettings = {
  appearance: AppearanceSettings
  providers: ProviderSettings
  chat: ChatSettings
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
  },
  chat: {
    defaultModel: "",
    defaultEffort: "high",
    showSuggestions: true,
    autoTitle: true,
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
    },
    chat: { ...DEFAULT_SETTINGS.chat, ...asObject(value.chat) },
    recentFolders: asFolderList(value.recentFolders),
  }
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
