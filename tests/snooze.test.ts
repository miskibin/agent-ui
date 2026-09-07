import assert from "node:assert/strict"
import { test } from "node:test"

import {
  snoozePresets,
  snoozeWakeDescription,
  timeLabel,
} from "@/lib/snooze"

/**
 * "Put this chat down until…" — the choices and the labels.
 *
 * Every instant here is built with the local-time `Date` constructor, because
 * that is what the module works in: a preset means 9:00 on the user's own
 * clock, not 9:00 UTC, and a test written in epoch milliseconds would pass in
 * one timezone and fail in the next.
 */

/** Wednesday, 1 April 2026, 10:00 local. */
const WEDNESDAY = new Date(2026, 3, 1, 10, 0, 0, 0).getTime()
const HOUR = 60 * 60 * 1000

function at(now: number) {
  return new Map(snoozePresets(now).map((preset) => [preset.id, preset]))
}

test("the fixed offsets are exactly that, and labelled with the clock", () => {
  const presets = at(WEDNESDAY)
  assert.equal(presets.get("hour")?.until, WEDNESDAY + HOUR)
  assert.equal(presets.get("hour")?.when, "11:00")
  assert.equal(presets.get("three-hours")?.until, WEDNESDAY + 3 * HOUR)
  assert.equal(presets.get("three-hours")?.when, "13:00")
})

test("this evening is 17:30 today", () => {
  const evening = at(WEDNESDAY).get("evening")
  assert.equal(evening?.when, "17:30")
  assert.deepEqual(
    new Date(evening?.until ?? 0),
    new Date(2026, 3, 1, 17, 30, 0, 0)
  )
})

test("this evening is dropped once the evening is near", () => {
  // 16:45 — inside the hour before 17:30, where "this evening" says nothing
  // that "in 1 hour" does not already say.
  assert.equal(at(new Date(2026, 3, 1, 16, 45).getTime()).has("evening"), false)
  assert.equal(at(new Date(2026, 3, 1, 21, 0).getTime()).has("evening"), false)
  assert.equal(at(new Date(2026, 3, 1, 16, 15).getTime()).has("evening"), true)
})

test("tomorrow is 9:00 the next calendar day", () => {
  const tomorrow = at(new Date(2026, 3, 1, 23, 45).getTime()).get("tomorrow")
  assert.deepEqual(
    new Date(tomorrow?.until ?? 0),
    new Date(2026, 3, 2, 9, 0, 0, 0)
  )
  assert.equal(tomorrow?.when, "9:00")
})

test("next week is the coming Monday, and a whole week of it on a Monday", () => {
  const wednesday = at(WEDNESDAY).get("next-week")
  assert.deepEqual(
    new Date(wednesday?.until ?? 0),
    new Date(2026, 3, 6, 9, 0, 0, 0)
  )
  assert.equal(wednesday?.when, "Mon 9:00")

  const monday = at(new Date(2026, 3, 6, 10, 0).getTime()).get("next-week")
  assert.deepEqual(
    new Date(monday?.until ?? 0),
    new Date(2026, 3, 13, 9, 0, 0, 0),
    "on a Monday, next week is the Monday after — not this morning"
  )
})

test("next week is dropped when it would be tomorrow anyway", () => {
  // Sunday: "Tomorrow" and "Next week" are the same Monday morning.
  const sunday = at(new Date(2026, 3, 5, 10, 0).getTime())
  assert.equal(sunday.has("tomorrow"), true)
  assert.equal(sunday.has("next-week"), false)
})

test("the wake description says today, tomorrow, this week, or the date", () => {
  const now = WEDNESDAY
  assert.equal(
    snoozeWakeDescription(new Date(2026, 3, 1, 17, 30).getTime(), now),
    "17:30"
  )
  assert.equal(
    snoozeWakeDescription(new Date(2026, 3, 2, 9, 0).getTime(), now),
    "tomorrow 9:00"
  )
  assert.equal(
    snoozeWakeDescription(new Date(2026, 3, 6, 9, 0).getTime(), now),
    "Mon 9:00"
  )
  assert.equal(
    snoozeWakeDescription(new Date(2026, 3, 13, 9, 0).getTime(), now),
    "Apr 13, 9:00"
  )
})

test("a wake that has already passed reads as a time, not as a negative", () => {
  assert.equal(
    snoozeWakeDescription(new Date(2026, 3, 1, 8, 0).getTime(), WEDNESDAY),
    "8:00"
  )
  assert.equal(snoozeWakeDescription(Number.NaN, WEDNESDAY), "")
})

test("the clock is 24-hour with a padded minute", () => {
  assert.equal(timeLabel(new Date(2026, 3, 1, 9, 5)), "9:05")
  assert.equal(timeLabel(new Date(2026, 3, 1, 17, 30)), "17:30")
  assert.equal(timeLabel(new Date(2026, 3, 1, 0, 0)), "0:00")
})
