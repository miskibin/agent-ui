// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

import type { SessionMeta } from "@/lib/store/types"

/**
 * Where a chat sits in its own life: still in play, put down until a moment
 * the user picked, or finished.
 *
 * The whole model is four optional timestamps on `SessionMeta` and one
 * override, read together only here. Nothing schedules anything and nothing
 * runs in the background — a chat becomes woken, or settled by age, because
 * the next read says so. That is what makes this file pure, and what makes the
 * sidebar's own `setTimeout` a rendering detail rather than the source of
 * truth: miss the timer and the classification is still right, just late.
 *
 * Precedence is **snooze > settled > pinned > active**, and it is not
 * arbitrary. A snooze is the most recent, most specific thing the user said,
 * so it outranks even a pin until it expires; settling is the next most
 * deliberate; a pin only decides where a chat that is still in play sits.
 */

const DAY_MS = 24 * 60 * 60 * 1_000

/** How long a chat may sit untouched before it settles on its own. */
export const AUTO_SETTLE_AFTER_DAYS = 14

export type SessionSection = "pinned" | "active" | "snoozed" | "settled"

/** Everything the rules here read — nothing else on a chat matters to them. */
export type LifecycleSession = Pick<
  SessionMeta,
  | "pinned"
  | "updatedAt"
  | "settledAt"
  | "settledOverride"
  | "snoozedUntil"
  | "snoozedAt"
  | "wokeAt"
  | "lastVisitedAt"
>

function time(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null
}

/** Still put down: the wake time exists and has not arrived yet. */
export function isSnoozed(
  session: LifecycleSession,
  now: number = Date.now()
): boolean {
  const until = time(session.snoozedUntil)
  return until !== null && until > now
}

/**
 * Finished. The user's own answer wins in both directions; with no answer, a
 * chat is settled exactly when something wrote `settledAt` — which is either a
 * settle gesture or the age rule below.
 */
export function isSettled(session: LifecycleSession): boolean {
  if (session.settledOverride === "settled") return true
  if (session.settledOverride === "active") return false
  return time(session.settledAt) !== null
}

/**
 * When a snoozed chat came back, until the user has seen it — `null` once they
 * have, and for a chat that never snoozed.
 *
 * A woken chat returns to the position it had before, because the sidebar's
 * order is deliberately stable; the pill is what carries the news instead. A
 * timer wake reports the wake time itself, an early wake reports when it was
 * woken, and either is cleared by a visit that came after it. A settled chat
 * has nothing to announce — it is not asking for attention.
 */
export function wokeAt(
  session: LifecycleSession,
  now: number = Date.now()
): number | null {
  if (isSnoozed(session, now) || isSettled(session)) return null
  const until = time(session.snoozedUntil)
  const timer = until !== null && until <= now ? until : null
  const early = time(session.wokeAt)
  const at = Math.max(timer ?? 0, early ?? 0)
  if (at === 0) return null
  const visited = time(session.lastVisitedAt)
  return visited !== null && visited >= at ? null : at
}

/** The section a chat is filed under, at this instant. */
export function sessionSection(
  session: LifecycleSession,
  now: number = Date.now()
): SessionSection {
  if (isSnoozed(session, now)) return "snoozed"
  if (isSettled(session)) return "settled"
  return session.pinned ? "pinned" : "active"
}

/**
 * What orders the Settled shelf: when the work *ended*, not when the chat was
 * created or last renamed. A chat settled by the age rule carries the
 * timestamp of the sweep that settled it; one settled by hand carries the
 * gesture. `updatedAt` is the fallback for a chat settled before the field
 * existed.
 */
export function settledTimestamp(session: LifecycleSession): number {
  return time(session.settledAt) ?? session.updatedAt
}

/** The soonest wake still ahead of us, or `null` — what the shelf's timer arms on. */
export function nextWake(
  sessions: readonly LifecycleSession[],
  now: number = Date.now()
): number | null {
  let soonest: number | null = null
  for (const session of sessions) {
    const until = time(session.snoozedUntil)
    if (until === null || until <= now) continue
    if (soonest === null || until < soonest) soonest = until
  }
  return soonest
}

export type AutoSettleOptions = {
  /** Days of silence before a chat settles itself. */
  afterDays?: number
  /** A turn is streaming in this chat right now. */
  running?: boolean
  /** The chat is holding an unanswered question. */
  awaiting?: boolean
}

/**
 * Whether the age rule would settle this chat *now*.
 *
 * Deliberately narrower than the reference it is adapted from: no "the PR
 * merged" rule, because this app has no such signal to trust. Silence is the
 * only evidence, and everything that could mean the chat is still in play
 * vetoes it — the user's own `"active"`, a pin, a run in flight, an unanswered
 * question, a snooze, and a wake the user has not looked at yet. Sweeping one
 * of those onto the shelf would hide work that is asking for an answer.
 */
export function autoSettle(
  session: LifecycleSession,
  now: number = Date.now(),
  options: AutoSettleOptions = {}
): boolean {
  const { afterDays = AUTO_SETTLE_AFTER_DAYS, running, awaiting } = options
  if (!Number.isFinite(afterDays) || afterDays <= 0) return false
  if (session.settledOverride === "active") return false
  if (isSettled(session)) return false
  if (session.pinned || running || awaiting) return false
  if (isSnoozed(session, now)) return false
  if (wokeAt(session, now) !== null) return false
  const last = Math.max(session.updatedAt, time(session.lastVisitedAt) ?? 0)
  return now - last >= afterDays * DAY_MS
}

/**
 * The `chat.autoSettleAfterDays` setting, read the way this app reads every
 * setting it does not own: defensively. Anything unusable is the default, and
 * a zero or negative value is the user turning the rule off — which is why
 * this answers `null` rather than a number the caller would have to interpret.
 */
export function autoSettleAfterDays(value: unknown): number | null {
  if (value === undefined || value === null) return AUTO_SETTLE_AFTER_DAYS
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return AUTO_SETTLE_AFTER_DAYS
  }
  return value > 0 ? value : null
}
