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
  /**
   * Cache reads and writes, when the backend reports them. They count toward
   * what the next turn's context has to fit but are billed at their own rates,
   * so they stay beside `inputTokens` rather than folded into it.
   */
  cachedInputTokens?: number
  cacheCreationTokens?: number
  /** Thinking tokens: a subset of `outputTokens`, never added on top. */
  reasoningTokens?: number
  /** The model's context window as the backend reported it for this turn. */
  contextWindow?: number
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
  /**
   * The worktree checkpoint this turn produced — see `lib/checkpoints`.
   *
   * `ref` is the hidden git ref holding the tree as it stood when the turn
   * ended, `baseRef` the one from just before it started, and `files` the
   * numstat between them. That last one is the reason this is stored rather
   * than recomputed: it is what the turn *actually* changed on disk, which is
   * a different thing from what its tool calls claimed — a script that wrote a
   * file, a formatter that ran on save and an edit the agent reverted are all
   * only visible here. `lib/turn-files` prefers it over the tool-derived list.
   *
   * Absent whenever the chat has no folder, the folder is not a checkout, or
   * git could not answer — the feature degrades to what it was before it.
   */
  checkpoint?: TurnCheckpoint
}

/** One row of the checkpoint diff: a file and how much of it moved. */
export type TurnCheckpointFile = {
  path: string
  insertions: number
  deletions: number
}

export type TurnCheckpoint = {
  /** `refs/agent-ui/checkpoints/<base64url(sessionId)>/turn/<n>`. */
  ref: string
  /** Which turn of the chat this is; the baseline before turn 1 is turn 0. */
  turn: number
  /** The checkpoint the turn started from, when there was one. */
  baseRef?: string
  /** `git diff --numstat baseRef ref`, taken once when the turn settled. */
  files?: TurnCheckpointFile[]
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

/**
 * One worktree, as a chat remembers it. Structurally the `WorktreeRef` that
 * `lib/worktree` returns — declared here as well so the client bundle and the
 * store can share it without importing a server-only module.
 */
export type SessionWorktree = {
  /** Absolute path of the worktree — the same value as `SessionMeta.cwd`. */
  root: string
  /** The branch checked out in it. */
  branch: string
  /** What that branch was created from, when it is known. */
  baseBranch?: string
  /** The main checkout the worktree belongs to. */
  repoRoot: string
}

/**
 * The user's own answer to "is this chat done?", which outranks the automatic
 * rule in both directions.
 */
export type SessionSettledOverride = "settled" | "active"

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
   * The git worktree this chat was started in, when it was started in one of
   * its own (see `lib/worktree`).
   *
   * `cwd` already points at `root` — this is the *provenance* beside it: which
   * repository the worktree belongs to, which branch it is on, and what that
   * branch was cut from. Three things read it and nothing else could answer
   * them from `cwd` alone: the sidebar, to label the section as a worktree of
   * a repo rather than as an unrelated folder; the delete path, to offer to
   * remove the worktree when the last chat using it goes away; and anything
   * that wants the *repository* rather than this checkout of it.
   *
   * Absent on every chat that simply picked a folder, which is most of them.
   */
  worktree?: SessionWorktree
  /**
   * Chat lifecycle — see `lib/session-lifecycle`, which is the only place the
   * four fields below are read together.
   *
   * A chat is *settled* when its work is done: it leaves the folder sections
   * for the Settled shelf. `settledAt` is when that happened (and what orders
   * the shelf); `settledOverride` is the user's own answer, which outranks the
   * automatic rule in both directions — `"settled"` settles a chat the rule
   * would have left alone, `"active"` keeps one the rule would have swept
   * away.
   */
  settledAt?: number
  settledOverride?: SessionSettledOverride
  /**
   * A chat the user put down until a moment they picked. `snoozedUntil` is
   * that moment; once it passes the chat is simply active again, wearing a
   * "Woke" pill until it is next visited. `snoozedAt` is when the snooze was
   * set, kept so a wake can be told from the snooze that preceded it.
   */
  snoozedUntil?: number
  snoozedAt?: number
  /**
   * When the chat came back early — a manual wake, a drag off the shelf. A
   * timer wake needs no field: `snoozedUntil` in the past already says it.
   */
  wokeAt?: number
  /**
   * When the chat was last opened. It exists to clear the "Woke" pill, which
   * is why it is deliberately *not* activity: it never moves `updatedAt`, and
   * so never reorders the sidebar.
   */
  lastVisitedAt?: number
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

/**
 * The lifecycle timestamps a patch may also *clear*: `0` removes the field,
 * which is how unsettling drops `settledAt` and waking drops `snoozedUntil`.
 * A patch that touches nothing else leaves `updatedAt` alone — settling a
 * chat, or visiting one, is not activity and must not reorder the sidebar.
 */
export type SessionLifecyclePatch = Partial<
  Pick<
    SessionMeta,
    "settledAt" | "snoozedUntil" | "snoozedAt" | "wokeAt" | "lastVisitedAt"
  >
> & {
  /** `""` hands the chat back to the automatic rule. */
  settledOverride?: SessionSettledOverride | ""
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
    | "worktree"
    | "permissionMode"
  >
> &
  SessionLifecyclePatch

export type CreateSessionInput = {
  title?: string
  providerId?: string
  model?: string
  cwd?: string
  gitBranch?: string
  worktree?: SessionWorktree
  permissionMode?: string
} & SessionLifecyclePatch
