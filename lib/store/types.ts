import type { ChatMessageData } from "@/components/ui/message-list"
import type {
  AgentSessionState,
  HandoffMarker,
} from "@/lib/handoff/types"

/**
 * Wire + on-disk shapes for the session store. Types only, so the client
 * bundle can share them with `lib/store/sessions` (which is server-only).
 */

/**
 * Provenance for one assistant turn — what answered, how long it took, what
 * it cost. Surfaced by the metadata button next to copy / regenerate / delete,
 * and every field is optional: a backend that reports nothing still produces a
 * turn worth keeping.
 */
export type MessageMetadata = {
  model?: string
  providerId?: string
  /** Seconds spent on the turn — rendered under the assistant message. */
  responseTime?: number
  /** Input + output, kept for turns stored before the split existed. */
  tokens?: number
  inputTokens?: number
  outputTokens?: number
  tokensPerSecond?: number
  /** Wall clock when the turn settled. */
  finishedAt?: number
  /** Working folder and branch the run actually used. */
  cwd?: string
  gitBranch?: string
  /**
   * The handoff block this turn was sent, when another agent had worked in
   * the chat since this one last ran. Kept on the message so the block is
   * inspectable in the thread rather than something the user has to trust.
   */
  handoff?: HandoffMarker
  /**
   * On a *user* message: exactly what the person typed, before the composer
   * added anything — a skill prefix, the fenced contents of an attached file,
   * the note naming the files it could not read.
   *
   * It exists for the memory boundary. `content` is what the model was sent,
   * and everything the composer folded into it is content the user did not
   * write; the extractor (`lib/memory/extract`) is only ever allowed the
   * user's own words, so it reads this and falls back to `content` only for
   * turns stored before the field existed.
   */
  typedText?: string
}

/** Exactly what the UI renders: `ChatMessageData` plus provenance. */
export type StoredMessage = ChatMessageData & {
  metadata?: MessageMetadata
  createdAt?: number
  /**
   * A turn the app wrote on the user's behalf — today, the answers submitted
   * to an Ask Question block. It stays in the thread because the model (and a
   * stateless provider replaying history) needs it, but the transcript already
   * shows those answers in the tool row, so it is filtered out of the list.
   */
  internal?: boolean
}

export type SessionMeta = {
  id: string
  title: string
  pinned: boolean
  /** Position in the sidebar; the array in `index.json` is kept in this order. */
  order: number
  providerId: string
  model: string
  /**
   * Provider-side conversation id — the pre-handoff, single-backend field.
   * Still read (an index written before `agentSessions` existed is migrated
   * from it on read) and still written for whichever provider ran last, so a
   * downgrade keeps working; `agentSessions` is what the chat route resumes
   * from.
   */
  providerSessionId?: string
  /**
   * One backend conversation per provider, keyed by provider id. Switching
   * agents inside a chat no longer throws the other one's session away: each
   * keeps its own id, its own journal cursor and its own worktree snapshot.
   */
  agentSessions?: Record<string, AgentSessionState>
  /**
   * Absolute path the agent works in for this chat, overriding the workspace
   * from settings. Empty / absent = the app's own cwd.
   */
  cwd?: string
  /** Git branch shown next to the folder. Display only — nothing checks out. */
  gitBranch?: string
  /**
   * Per-chat permission mode (`lib/providers/types`'s `PermissionMode`), for
   * harnesses that publish `capabilities.permissionModes`. Kept as a plain
   * string here so the store never has to be migrated when the vocabulary
   * grows; the chat route validates it against the provider before use.
   */
  permissionMode?: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export type SessionPatch = Partial<
  Pick<
    SessionMeta,
    | "title"
    | "pinned"
    | "order"
    | "providerId"
    | "model"
    | "providerSessionId"
    | "agentSessions"
    | "cwd"
    | "gitBranch"
    | "permissionMode"
  >
>

export type CreateSessionInput = {
  title?: string
  providerId?: string
  model?: string
  cwd?: string
  gitBranch?: string
  permissionMode?: string
}
