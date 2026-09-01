import type { ChatMessageData } from "@/components/ui/message-list"

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
  /** Provider-side conversation id, for providers with `capabilities.resume`. */
  providerSessionId?: string
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
