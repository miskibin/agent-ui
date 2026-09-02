import {
  sameWorkingFolder,
  type AgentSessionState,
  type WorktreeSnapshot,
} from "@/lib/handoff/types"

/**
 * The two rules that decide what a chat remembers about an agent, kept pure
 * and away from the route so they can be reasoned about (and tested) on their
 * own. Both are easy to get subtly wrong and expensive when they are.
 */

/**
 * The backend session to resume, if any.
 *
 * The folder is part of the identity: an id minted while the chat pointed at
 * one checkout resumes a conversation about files that are not in another, so
 * repointing the chat starts a fresh backend session rather than a confused
 * one. Changing the *model* is not part of the identity — the same harness
 * carries on with the same conversation.
 */
export function resolveResumeSessionId(
  entry: AgentSessionState | undefined,
  cwd: string | undefined,
  canResume: boolean
): string | undefined {
  if (!canResume || !entry?.providerSessionId) return undefined
  return sameWorkingFolder(entry.cwd, cwd) ? entry.providerSessionId : undefined
}

/**
 * This agent's state after a turn.
 *
 * `lastSeenSeq` only moves when the run actually started, and that is the
 * whole cursor discipline in one line: a spawn failure, a refused connection
 * or an abort before the backend said anything means the agent never received
 * the handoff, so the same one must be offered again next turn. Once it has
 * started, the turn counts even if it then failed or was stopped — its
 * backend has the prompt either way.
 */
export function nextAgentSessionState(args: {
  previous?: AgentSessionState
  /** Last seq in the journal after this turn's events were appended. */
  journalEnd: number
  /** Whether this turn wrote anything to the journal. */
  wrote: boolean
  runStarted: boolean
  cwd?: string
  providerSessionId?: string
  snapshot?: WorktreeSnapshot
  now: number
}): AgentSessionState {
  const previous = args.previous
  const providerSessionId =
    args.providerSessionId || previous?.providerSessionId || undefined
  const snapshot = args.snapshot ?? previous?.snapshot
  return {
    ...(providerSessionId ? { providerSessionId } : null),
    ...(args.cwd ? { cwd: args.cwd } : null),
    lastSeenSeq: args.runStarted
      ? Math.max(args.journalEnd, previous?.lastSeenSeq ?? 0)
      : (previous?.lastSeenSeq ?? 0),
    lastWroteSeq: args.wrote
      ? Math.max(args.journalEnd, previous?.lastWroteSeq ?? 0)
      : (previous?.lastWroteSeq ?? 0),
    lastActiveAt: args.now,
    ...(snapshot ? { snapshot } : null),
  }
}

/**
 * Per-provider state read back from an index file, migrating one written
 * before it existed: a lone `providerSessionId` belonged to whichever
 * provider the chat last used, so it becomes that provider's entry — with a
 * zero journal cursor, which is right, because nothing was journaled then.
 */
export function migrateAgentSessions(
  raw: unknown,
  legacy: {
    providerId: string
    providerSessionId: string
    cwd?: string
    updatedAt: number
  }
): Record<string, AgentSessionState> | undefined {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const entries: Record<string, AgentSessionState> = {}
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!id || !value || typeof value !== "object") continue
      const state = value as Record<string, unknown>
      entries[id] = {
        ...(typeof state.providerSessionId === "string" &&
        state.providerSessionId
          ? { providerSessionId: state.providerSessionId }
          : null),
        ...(typeof state.cwd === "string" ? { cwd: state.cwd } : null),
        lastSeenSeq: asCount(state.lastSeenSeq),
        lastWroteSeq: asCount(state.lastWroteSeq),
        lastActiveAt:
          typeof state.lastActiveAt === "number" ? state.lastActiveAt : 0,
        ...(readSnapshot(state.snapshot) ?? null),
      }
    }
    return Object.keys(entries).length > 0 ? entries : undefined
  }
  if (!legacy.providerId || !legacy.providerSessionId) return undefined
  return {
    [legacy.providerId]: {
      providerSessionId: legacy.providerSessionId,
      ...(legacy.cwd ? { cwd: legacy.cwd } : null),
      lastSeenSeq: 0,
      lastWroteSeq: 0,
      lastActiveAt: legacy.updatedAt,
    },
  }
}

function readSnapshot(raw: unknown) {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  if (typeof value.head !== "string" || !Array.isArray(value.status)) return null
  return {
    snapshot: {
      head: value.head,
      status: value.status.filter((line): line is string => typeof line === "string"),
    },
  }
}

function asCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0
}
