import "server-only"

import { buildHandoff } from "@/lib/handoff/build"
import {
  nextAgentSessionState,
  resolveResumeSessionId,
} from "@/lib/handoff/cursor"
import { lastSeq } from "@/lib/handoff/journal"
import { readDiffStat, readWorktreeSnapshot } from "@/lib/handoff/snapshot"
import type {
  AgentSessionState,
  HandoffResult,
  NewJournalEvent,
  WorktreeSnapshot,
} from "@/lib/handoff/types"
import { appendJournal, readJournal } from "@/lib/store/sessions"
import type { SessionMeta } from "@/lib/store/types"

/**
 * The turn-scoped half of the handoff: what the chat route needs before a run
 * starts, and what it has to write back once the run settles.
 *
 * Two cursors live here and they are not the same thing:
 *
 *   `lastSeenSeq`   what this agent has already been told about. It advances
 *                   to the end of its own turn — but only once the run
 *                   actually started, so a spawn failure re-sends the handoff
 *                   next time instead of swallowing it.
 *   `lastWroteSeq`  the last event this agent produced. The composer reads it
 *                   to say "handoff pending" without opening the journal.
 *
 * Everything git-shaped is best-effort: `lib/handoff/snapshot` returns
 * undefined on any failure, and every caller treats that as "say nothing".
 */

export type PreparedTurn = {
  /** Backend session to resume, once the folder rule has been applied. */
  resumeSessionId?: string
  /** The block to send as `turnContext`, when there is one. */
  handoff?: HandoffResult
  /** Per-provider state as it stood at turn start. */
  agentSessions: Record<string, AgentSessionState>
  /** This provider's entry at turn start, if it had one. */
  entry?: AgentSessionState
}

export async function prepareTurn(args: {
  session: SessionMeta
  providerId: string
  cwd: string | undefined
  canResume: boolean
  enabled: boolean
}): Promise<PreparedTurn> {
  const agentSessions = args.session.agentSessions ?? {}
  const entry = agentSessions[args.providerId]

  const resumeSessionId = resolveResumeSessionId(entry, args.cwd, args.canResume)

  if (!args.enabled) return { resumeSessionId, agentSessions, entry }

  let handoff: HandoffResult | undefined
  try {
    const events = await readJournal(args.session.id)
    const lastSeenSeq = entry?.lastSeenSeq ?? 0
    // Nothing to compare against, and nothing to describe: skip the git reads
    // entirely rather than pay for them on every first turn.
    const hasDelta = events.some(
      (event) =>
        event.seq > lastSeenSeq && event.providerId !== args.providerId
    )
    if (hasDelta || entry?.snapshot) {
      const current = await readWorktreeSnapshot(args.cwd)
      const diffStat = await readDiffStat(args.cwd, entry?.snapshot?.head)
      handoff = buildHandoff({
        events,
        lastSeenSeq,
        providerId: args.providerId,
        snapshot: entry?.snapshot,
        current,
        ...(diffStat ? { diffStat } : null),
      })
    }
  } catch {
    /* a broken journal or a hostile git must not cost the user an answer */
  }

  return { resumeSessionId, handoff, agentSessions, entry }
}

/**
 * Writes the turn's events and returns the per-provider state to persist.
 *
 * `runStarted` is the whole point of the second cursor: it must mean the
 * backend actually took the prompt (a `session` id, a token, a tool call, a
 * completed turn) — not that the app got as far as saying "connecting" or
 * that a spawn failed loudly.
 */
export async function commitTurn(args: {
  sessionId: string
  providerId: string
  cwd: string | undefined
  prepared: PreparedTurn
  events: NewJournalEvent[]
  runStarted: boolean
  providerSessionId?: string
  enabled: boolean
}): Promise<Record<string, AgentSessionState>> {
  const previous = args.prepared.entry
  let journalEnd = 0
  let wrote = false
  let snapshot: WorktreeSnapshot | undefined

  if (args.enabled) {
    try {
      const journal = await appendJournal(args.sessionId, args.events)
      journalEnd = lastSeq(journal)
      wrote = args.events.length > 0
    } catch {
      /* the answer is already delivered; a journal write is not worth it */
    }
    snapshot = await readWorktreeSnapshot(args.cwd)
  }

  const entry = nextAgentSessionState({
    ...(previous ? { previous } : null),
    journalEnd,
    wrote,
    runStarted: args.runStarted,
    ...(args.cwd ? { cwd: args.cwd } : null),
    ...(args.providerSessionId
      ? { providerSessionId: args.providerSessionId }
      : null),
    ...(snapshot ? { snapshot } : null),
    now: Date.now(),
  })

  // Every other provider's entry is left exactly as it was: switching agents
  // must not cost the one being switched away from its resumable session.
  return { ...args.prepared.agentSessions, [args.providerId]: entry }
}
