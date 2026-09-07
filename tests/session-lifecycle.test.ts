import assert from "node:assert/strict"
import { test } from "node:test"

import {
  AUTO_SETTLE_AFTER_DAYS,
  autoSettle,
  autoSettleAfterDays,
  isSettled,
  isSnoozed,
  nextWake,
  sessionSection,
  settledTimestamp,
  wokeAt,
} from "@/lib/session-lifecycle"
import type { SessionMeta } from "@/lib/store/types"

/**
 * Where a chat sits in its own life. Every rule here is evaluated on read, so
 * the tests are the whole specification: there is no scheduler to observe.
 */

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function meta(extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    title: "chat",
    pinned: false,
    order: 0,
    providerId: "mock",
    model: "",
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW,
    messageCount: 2,
    ...extra,
  }
}

/* -------------------------------------------------------------------------- */
/* Precedence                                                                  */
/* -------------------------------------------------------------------------- */

test("a plain chat is active, and a pinned one is pinned", () => {
  assert.equal(sessionSection(meta(), NOW), "active")
  assert.equal(sessionSection(meta({ pinned: true }), NOW), "pinned")
})

test("a snooze outranks settled, and settled outranks a pin", () => {
  const everything = meta({
    pinned: true,
    settledOverride: "settled",
    snoozedUntil: NOW + HOUR,
  })
  assert.equal(sessionSection(everything, NOW), "snoozed")
  assert.equal(
    sessionSection({ ...everything, snoozedUntil: undefined }, NOW),
    "settled"
  )
  assert.equal(
    sessionSection(
      { ...everything, snoozedUntil: undefined, settledOverride: undefined },
      NOW
    ),
    "pinned"
  )
})

test("a snooze whose time has passed is not a snooze any more", () => {
  const woken = meta({ snoozedUntil: NOW - 1 })
  assert.equal(isSnoozed(woken, NOW), false)
  assert.equal(sessionSection(woken, NOW), "active")
  assert.equal(sessionSection(meta({ snoozedUntil: NOW + 1 }), NOW), "snoozed")
})

test("the user's answer outranks the automatic settled flag both ways", () => {
  assert.equal(isSettled(meta({ settledAt: NOW - DAY })), true)
  assert.equal(
    isSettled(meta({ settledAt: NOW - DAY, settledOverride: "active" })),
    false
  )
  assert.equal(isSettled(meta({ settledOverride: "settled" })), true)
})

/* -------------------------------------------------------------------------- */
/* Woke                                                                        */
/* -------------------------------------------------------------------------- */

test("a chat whose snooze ran out says so until it is visited", () => {
  const woken = meta({ snoozedUntil: NOW - HOUR, snoozedAt: NOW - 5 * HOUR })
  assert.equal(wokeAt(woken, NOW), NOW - HOUR)
  assert.equal(wokeAt({ ...woken, lastVisitedAt: NOW - 30 * 60_000 }, NOW), null)
  // A visit from *before* the wake does not clear news it could not have seen.
  assert.equal(
    wokeAt({ ...woken, lastVisitedAt: NOW - 2 * HOUR }, NOW),
    NOW - HOUR
  )
})

test("a chat still asleep, and a settled one, have nothing to announce", () => {
  assert.equal(wokeAt(meta({ snoozedUntil: NOW + HOUR }), NOW), null)
  assert.equal(
    wokeAt(meta({ snoozedUntil: NOW - HOUR, settledOverride: "settled" }), NOW),
    null
  )
  assert.equal(wokeAt(meta(), NOW), null)
})

test("an early wake is reported at the moment it happened", () => {
  const early = meta({ snoozedUntil: NOW + 5 * HOUR, wokeAt: NOW - HOUR })
  // Still snoozed by its own timestamp — nothing to announce yet.
  assert.equal(wokeAt(early, NOW), null)
  assert.equal(wokeAt({ ...early, snoozedUntil: NOW - 3 * HOUR }, NOW), NOW - HOUR)
})

/* -------------------------------------------------------------------------- */
/* Ordering and timers                                                         */
/* -------------------------------------------------------------------------- */

test("the settled shelf orders by when the work ended", () => {
  assert.equal(settledTimestamp(meta({ settledAt: NOW - DAY })), NOW - DAY)
  // A chat settled before the field existed still has to sort somewhere.
  assert.equal(settledTimestamp(meta({ updatedAt: 42 })), 42)
})

test("the next wake is the soonest one still ahead", () => {
  const list = [
    meta({ id: "a", snoozedUntil: NOW + 5 * HOUR }),
    meta({ id: "b", snoozedUntil: NOW + HOUR }),
    meta({ id: "c", snoozedUntil: NOW - HOUR }),
    meta({ id: "d" }),
  ]
  assert.equal(nextWake(list, NOW), NOW + HOUR)
  assert.equal(nextWake([meta(), meta({ snoozedUntil: NOW - 1 })], NOW), null)
  assert.equal(nextWake([], NOW), null)
})

/* -------------------------------------------------------------------------- */
/* The age rule                                                                */
/* -------------------------------------------------------------------------- */

test("silence for the configured number of days settles a chat", () => {
  const quiet = meta({ updatedAt: NOW - 20 * DAY })
  assert.equal(autoSettle(quiet, NOW), true)
  assert.equal(autoSettle(meta({ updatedAt: NOW - 3 * DAY }), NOW), false)
  assert.equal(
    autoSettle(meta({ updatedAt: NOW - 3 * DAY }), NOW, { afterDays: 2 }),
    true
  )
  assert.equal(AUTO_SETTLE_AFTER_DAYS, 14)
})

test("a visit counts as activity for the rule, without being activity", () => {
  const visited = meta({ updatedAt: NOW - 20 * DAY, lastVisitedAt: NOW - DAY })
  assert.equal(autoSettle(visited, NOW), false)
})

test("everything that could still be in play vetoes the rule", () => {
  const quiet = meta({ updatedAt: NOW - 20 * DAY })
  assert.equal(autoSettle({ ...quiet, settledOverride: "active" }, NOW), false)
  assert.equal(autoSettle({ ...quiet, pinned: true }, NOW), false)
  assert.equal(autoSettle(quiet, NOW, { running: true }), false)
  assert.equal(autoSettle(quiet, NOW, { awaiting: true }), false)
  assert.equal(
    autoSettle({ ...quiet, snoozedUntil: NOW + HOUR }, NOW),
    false,
    "a chat put down for later has not been abandoned"
  )
  assert.equal(
    autoSettle({ ...quiet, snoozedUntil: NOW - HOUR }, NOW),
    false,
    "a chat that just came back is not swept away before it is seen"
  )
  assert.equal(
    autoSettle({ ...quiet, settledAt: NOW - DAY }, NOW),
    false,
    "already settled"
  )
})

test("the day count is read defensively, and zero turns the rule off", () => {
  assert.equal(autoSettleAfterDays(undefined), AUTO_SETTLE_AFTER_DAYS)
  assert.equal(autoSettleAfterDays("soon"), AUTO_SETTLE_AFTER_DAYS)
  assert.equal(autoSettleAfterDays(Number.NaN), AUTO_SETTLE_AFTER_DAYS)
  assert.equal(autoSettleAfterDays(30), 30)
  assert.equal(autoSettleAfterDays(0), null)
  assert.equal(autoSettleAfterDays(-1), null)
  assert.equal(
    autoSettle(meta({ updatedAt: NOW - 400 * DAY }), NOW, { afterDays: 0 }),
    false
  )
})
