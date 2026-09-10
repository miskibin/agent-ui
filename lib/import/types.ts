/**
 * Importing a CLI's own history into the app.
 *
 * Claude Code and Codex both keep every conversation as a JSONL transcript
 * under their home directory, and each transcript records the folder it ran
 * in. That is enough to offer the user their existing work as chats here:
 * group the transcripts by `cwd`, let them pick the folders worth bringing
 * over, and write each conversation through `lib/store` as an ordinary
 * session.
 *
 * Types only, so `components/import-dialog.tsx` can share them with the
 * server-only halves under this directory.
 *
 * Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
 */

/**
 * The vocabulary the wire speaks. Deliberately *not* the app's provider ids:
 * `claude-code` reads better in a URL than the `claudeCode` settings key;
 * Codex uses `codex` in both places. `lib/import/import.ts`
 * is the one place the two are mapped onto each other.
 */
export type ImportProvider = "claude-code" | "codex"

export const IMPORT_PROVIDERS: readonly ImportProvider[] = [
  "claude-code",
  "codex",
]

export function isImportProvider(value: unknown): value is ImportProvider {
  return value === "claude-code" || value === "codex"
}

/** One working folder a CLI has run in, as the picker lists it. */
export type ImportProject = {
  /** Absolute path the transcripts recorded — the chat's folder once imported. */
  cwd: string
  provider: ImportProvider
  /** How many conversations were found for this folder. */
  conversations: number
  /** Newest transcript mtime, epoch millis. */
  lastActiveAt: number
  /**
   * Whether an imported chat can be *continued* rather than only read: true
   * only when this app has a provider that resumes the CLI's own session ids.
   * False for Codex, which has no backend here yet.
   */
  resumable: boolean
}

export type ImportScanResult = {
  projects: ImportProject[]
  /** A home directory large enough that the scan stopped short of the end. */
  truncated?: boolean
}

/** One visible turn of an imported conversation. */
export type ImportedMessage = {
  role: "user" | "assistant"
  text: string
  /** Epoch millis, from the record's own timestamp where it had one. */
  at: number
  /** What the assistant turn reported, when the transcript carried it. */
  usage?: ImportedUsage
  model?: string
}

export type ImportedUsage = {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheCreationTokens?: number
}

/** One conversation, parsed out of a single transcript file. */
export type ImportedConversation = {
  provider: ImportProvider
  /**
   * The CLI's own conversation id. Present only when it is a shape the CLI's
   * `--resume` would take back — an id that fails that check is history, not a
   * session, and is imported without one.
   */
  sessionId?: string
  cwd: string
  title: string
  /** Model the transcript last named, for the imported chat's picker. */
  model?: string
  createdAt: number
  updatedAt: number
  messages: ImportedMessage[]
  /** Absolute path of the transcript it came from. */
  sourcePath: string
}

export type ImportRequest = {
  provider: ImportProvider
  /** Only conversations whose transcript recorded one of these folders. */
  cwds?: string[]
  /** Only these CLI session ids. Applied on top of `cwds` when both are given. */
  sessionIds?: string[]
}

export type ImportResult = {
  imported: number
  /** Already present (same CLI session id) or unusable, and left alone. */
  skipped: number
}
