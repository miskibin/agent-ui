/**
 * Wire and on-disk shapes for notes. Types and pure helpers only, so the page
 * shares them with the server half (`lib/notes/server`).
 *
 * A note is a markdown file the person writes and an agent works in. The file
 * is the note; everything here is what sits beside it: the index row the
 * sidebar reads, the threads hung on its words, and the revision counter that
 * lets two writers — the person typing and an agent editing — notice each
 * other.
 */

export type NoteMeta = {
  id: string
  /** The first heading of the note, else "Untitled". */
  title: string
  createdAt: number
  updatedAt: number
  /** Bumped by every write, whoever made it. */
  rev: number
  /**
   * The hidden chat the note's agent turns run in (`SessionMeta.noteId`), so
   * a harness that resumes keeps the conversation across asks.
   */
  chatId?: string
  /** The harness and model the last ask used — what the next one defaults to. */
  providerId?: string
  model?: string
}

export type NoteAuthor = "user" | "agent" | "external"

export type NoteDoc = { meta: NoteMeta; content: string }

export type NoteThreadStatus = "queued" | "running" | "done" | "error" | "cancelled"

export type NoteThreadMessage = {
  id: string
  author: "user" | "agent"
  text: string
  at: number
  error?: boolean
}

/**
 * A request hung on words in the note, Claude Docs style: the person selects,
 * asks, and the thread is where the agent answers — the change itself is
 * already in the note, so the reply says what changed, not the content again.
 */
export type NoteThread = {
  id: string
  /** The selected words the thread hangs on. */
  anchor: string
  status: NoteThreadStatus
  resolved?: boolean
  createdAt: number
  updatedAt: number
  messages: NoteThreadMessage[]
}

export type NoteHistoryEntry = {
  rev: number
  at: number
  author: NoteAuthor
}

/** What `/api/notes/<id>/events` streams. */
export type NoteEvent =
  | { type: "content"; rev: number; author: NoteAuthor }
  | { type: "threads" }

export function isValidNoteId(id: string) {
  return /^n[a-f0-9]{16}$/.test(id)
}

export const UNTITLED_NOTE = "Untitled"

/**
 * Whether a harness can work in a note: it has to reach the app's MCP bridge,
 * where the note tools live. Claude Code takes MCP servers natively, pi gets
 * them through its generated extension, and the mock agent drives the bridge
 * itself so the flow runs with nothing installed.
 */
export function canWorkInNotes(provider: { id: string; available: boolean; capabilities: { mcp?: boolean } }) {
  return provider.available && (provider.capabilities.mcp === true || provider.id === "pi" || provider.id === "mock")
}
