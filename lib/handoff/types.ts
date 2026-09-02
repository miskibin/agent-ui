/**
 * Shapes for the per-chat agent handoff. Types and pure helpers only, so the
 * browser bundle can share them with the server-only halves of `lib/handoff`.
 *
 * The division of labour with `lib/memory` is deliberate and load-bearing:
 *
 *   lib/memory   durable, cross-chat, about the *user* — reaches a turn as
 *                `standingContext` and is written to disk under `memory/`.
 *   lib/handoff  ephemeral, one chat, about the *other agents* — reaches a
 *                turn as `turnContext` and never outlives the chat.
 *
 * Nothing crosses: a handoff never carries memory facts, and nothing here is
 * ever handed to the memory extractor (which only ever sees stored user
 * messages, and the stored user message is exactly what the user typed).
 */

/**
 * What `git` said about the working folder at the end of a turn — cheap on
 * purpose: one `rev-parse` and one `porcelain` status, no index or tree of
 * our own. Absent (rather than a sentinel) when the folder is not a repo, git
 * is missing, or the read timed out; two snapshots can only be compared when
 * both exist.
 */
export type WorktreeSnapshot = {
  /** `git rev-parse HEAD`. */
  head: string
  /** `git status --porcelain=v1 --untracked-files=all`, one entry per line. */
  status: string[]
}

/**
 * One backend conversation, kept per provider so switching agents inside a
 * chat does not throw the other one's session away.
 *
 * `lastSeenSeq` and `lastWroteSeq` are two different cursors over the same
 * journal: what this agent has already been *told about* (its own turns plus
 * any handoff it actually received), and the last event it *produced*. The
 * second is what lets the composer say "handoff pending" without reading the
 * journal.
 */
export type AgentSessionState = {
  /** Provider-side conversation id, for providers with `capabilities.resume`. */
  providerSessionId?: string
  /** Folder the id was minted in — a different one means a fresh session. */
  cwd?: string
  /** Highest journal seq this agent has already seen. */
  lastSeenSeq: number
  /** Highest journal seq this agent wrote. */
  lastWroteSeq: number
  /** Wall clock of this agent's last turn in the chat. */
  lastActiveAt: number
  /** The worktree as this agent last left it. */
  snapshot?: WorktreeSnapshot
}

/** Semantic events a turn appends to the chat's journal. */
export type JournalEventKind = "user-message" | "tool" | "turn-end"

export type JournalEventBase = {
  /** Monotonic within a chat; only ever assigned by the store. */
  seq: number
  at: number
  providerId: string
}

export type JournalUserMessage = {
  kind: "user-message"
  /** Truncated: the journal is a summary, not a second transcript. */
  text: string
}

export type JournalTool = {
  kind: "tool"
  name: string
  /** Terminal statuses only — a `running` row says nothing yet. */
  status: "done" | "error"
  /** File paths the call named, in the order they appeared. */
  paths?: string[]
  /** Command text, for shell-shaped tools. */
  command?: string
  /** Only when the backend published one; absent is not zero. */
  exitCode?: number
}

export type JournalTurnEnd = {
  kind: "turn-end"
  model: string
  outcome: "ok" | "error" | "aborted"
  error?: string
}

export type JournalEvent = JournalEventBase &
  (JournalUserMessage | JournalTool | JournalTurnEnd)

/**
 * A journal event before the store has given it a seq. Distributed over the
 * union member by member — a plain `Omit` would collapse the three variants
 * to the fields they share.
 */
export type NewJournalEvent = JournalEvent extends infer T
  ? T extends JournalEvent
    ? Omit<T, "seq" | "at"> & { at?: number }
    : never
  : never

/**
 * What a turn was handed, kept on the assistant message so the block is
 * inspectable after the fact rather than something the user has to take on
 * trust. The counts are what the collapsed marker shows; `text` is exactly
 * what the agent was sent.
 */
export type HandoffMarker = {
  chars: number
  files: number
  commands: number
  errors: number
  staleWorktree: boolean
  text: string
}

/** Everything a build produced: the block to send, and its marker. */
export type HandoffResult = {
  text: string
  marker: HandoffMarker
  /** Highest seq folded into the block — the cursor a started run consumes. */
  throughSeq: number
}

/**
 * The app-level frame the chat route sends after a turn settles — what the
 * turn was handed, and which agents now hold a session in this chat.
 *
 * Deliberately not an `AgentStreamEvent`: that protocol is vendored and
 * describes what a *backend* says, while this is the app talking to its own
 * client. `lib/api-client` peels it off the SSE stream before the reducer
 * ever sees it.
 */
export type TurnStateFrame = {
  type: "turn-state"
  /** Assistant message the marker belongs to. */
  messageId: string
  agentSessions?: Record<string, AgentSessionState>
  handoff?: HandoffMarker
}

/** What the composer shows per provider for the chat that is open. */
export type ProviderSessionHint = {
  /** A stored backend session this folder can actually resume. */
  resumes: boolean
  lastActiveAt: number
  /** Another agent has written to the journal since this one last looked. */
  handoffPending: boolean
}

/**
 * Two folders are the same conversation only when they are the same string
 * after trimming; an empty one (the app's own cwd) matches another empty one.
 */
export function sameWorkingFolder(a?: string, b?: string) {
  return (a ?? "").trim() === (b ?? "").trim()
}

/**
 * Plain code-point order. Deliberately not `localeCompare`: the snapshot is
 * compared, never shown, and a locale-dependent order would make two machines
 * disagree about whether the same tree changed.
 */
function byCodePoint(a: string, b: string) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** Different commit, or a different set of dirty paths. */
export function snapshotsDiffer(a: WorktreeSnapshot, b: WorktreeSnapshot) {
  if (a.head !== b.head) return true
  if (a.status.length !== b.status.length) return true
  const left = [...a.status].sort(byCodePoint)
  const right = [...b.status].sort(byCodePoint)
  return left.some((line, index) => line !== right[index])
}

/**
 * Per-provider composer hints for one chat. Pure so the picker can render
 * from the session index alone, with no extra round trip.
 */
export function providerSessionHints(
  agentSessions: Record<string, AgentSessionState> | undefined,
  cwd: string | undefined
): Record<string, ProviderSessionHint> {
  const hints: Record<string, ProviderSessionHint> = {}
  if (!agentSessions) return hints
  for (const [providerId, state] of Object.entries(agentSessions)) {
    const others = Object.entries(agentSessions).filter(
      ([id]) => id !== providerId
    )
    hints[providerId] = {
      resumes:
        Boolean(state.providerSessionId) && sameWorkingFolder(state.cwd, cwd),
      lastActiveAt: state.lastActiveAt,
      handoffPending: others.some(
        ([, other]) => other.lastWroteSeq > state.lastSeenSeq
      ),
    }
  }
  return hints
}
