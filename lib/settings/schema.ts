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
  /** Corner radius base in rem applied to --radius. */
  radius: number
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: { theme: "default", mode: "system", radius: 0.625 },
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
}

/** Deep-merges a possibly stale/partial persisted value over the defaults. */
export function normalizeSettings(raw: unknown): AppSettings {
  const value = (raw ?? {}) as Partial<Record<keyof AppSettings, unknown>>
  return {
    appearance: {
      ...DEFAULT_SETTINGS.appearance,
      ...asObject(value.appearance),
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
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
