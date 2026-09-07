import assert from "node:assert/strict"
import { test } from "node:test"

import {
  applyUsageLimitsUpdate,
  clampPercent,
  formatResetWait,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
  type ProviderUsageLimits,
  type ProviderUsageWindow,
} from "@/lib/usage-limits"

/**
 * Reconciling the two sources a harness learns its quota from: the full read
 * taken once, and the sparse notices a run streams while it happens. The
 * rules that matter are that a notice never blanks a field the read
 * established, and that a repeat saying nothing new allocates nothing.
 */

const CHECKED = "2026-05-01T12:00:00.000Z"
const LATER = "2026-05-01T12:05:00.000Z"

function window(
  id: string,
  usedPercent: number,
  extra: Partial<ProviderUsageWindow> = {}
): ProviderUsageWindow {
  return {
    id,
    kind: "session",
    label: id,
    usedPercent,
    ...extra,
  }
}

test("windows sort by kind and then by id, whatever order they arrive in", () => {
  const limits = makeUsageLimits({
    checkedAt: CHECKED,
    windows: [
      window("weekly-b", 10, { kind: "weekly" }),
      window("overage", 5, { kind: "other" }),
      window("weekly-a", 20, { kind: "weekly" }),
      window("five_hour", 30),
    ],
  })
  assert.deepEqual(
    limits.windows.map((one) => one.id),
    ["five_hour", "weekly-a", "weekly-b", "overage"]
  )
})

test("a percentage outside the scale is clamped, not believed", () => {
  assert.equal(clampPercent(-4), 0)
  assert.equal(clampPercent(140), 100)
  assert.equal(clampPercent(Number.NaN), 0)
  assert.equal(clampPercent(42.5), 42.5)
})

test("an update upserts by id and leaves the windows it did not name", () => {
  const previous = makeUsageLimits({
    checkedAt: CHECKED,
    windows: [
      window("five_hour", 40, { resetsAt: CHECKED, windowDurationMins: 300 }),
      window("seven_day", 10, { kind: "weekly", windowDurationMins: 10080 }),
    ],
  })
  const next = applyUsageLimitsUpdate({
    previous,
    update: { windows: [window("five_hour", 96)] },
    checkedAt: LATER,
  })
  assert.equal(next?.checkedAt, LATER)
  assert.equal(next?.windows.length, 2)
  const five = next?.windows.find((one) => one.id === "five_hour")
  assert.equal(five?.usedPercent, 96)
  // The read's reset time and duration survive a notice that omitted them.
  assert.equal(five?.resetsAt, CHECKED)
  assert.equal(five?.windowDurationMins, 300)
  assert.equal(
    next?.windows.find((one) => one.id === "seven_day")?.usedPercent,
    10
  )
})

test("a repeat that changes nothing keeps the very same snapshot", () => {
  const previous = makeUsageLimits({
    checkedAt: CHECKED,
    windows: [window("five_hour", 40, { resetsAt: CHECKED })],
  })
  const next = applyUsageLimitsUpdate({
    previous,
    update: { windows: [window("five_hour", 40, { resetsAt: CHECKED })] },
    checkedAt: LATER,
  })
  // Identity, not just equality: these arrive beside every usage tick.
  assert.equal(next, previous)
})

test("an empty update, and an unsupported account, change nothing", () => {
  const previous = makeUsageLimits({
    checkedAt: CHECKED,
    windows: [window("five_hour", 40)],
  })
  assert.equal(
    applyUsageLimitsUpdate({ previous, update: { windows: [] }, checkedAt: LATER }),
    previous
  )

  const unsupported = makeUnavailableUsageLimits({
    checkedAt: CHECKED,
    reason: "unsupported",
  })
  assert.equal(
    applyUsageLimitsUpdate({
      previous: unsupported,
      update: { windows: [window("five_hour", 40)] },
      checkedAt: LATER,
    }),
    unsupported
  )
})

test("an update with nothing published yet stands on its own", () => {
  const next = applyUsageLimitsUpdate({
    previous: undefined,
    update: { windows: [window("five_hour", 200)] },
    checkedAt: CHECKED,
  })
  assert.deepEqual(next?.windows, [window("five_hour", 100)])
})

test("a failed read leaves the last good snapshot standing", () => {
  const published: ProviderUsageLimits = makeUsageLimits({
    checkedAt: CHECKED,
    windows: [window("five_hour", 40)],
  })
  const failed = makeUnavailableUsageLimits({
    checkedAt: LATER,
    reason: "probeFailed",
    message: "claude exited with code 1",
  })
  assert.equal(resolveUsageLimitsAfterProbe({ published, probed: failed }), published)

  // `unsupported` is authoritative — the account simply has no windows.
  const unsupported = makeUnavailableUsageLimits({
    checkedAt: LATER,
    reason: "unsupported",
  })
  assert.equal(
    resolveUsageLimitsAfterProbe({ published, probed: unsupported }),
    unsupported
  )
  // And a good read replaces what a turn established while it was running.
  const fresh = makeUsageLimits({
    checkedAt: LATER,
    windows: [window("five_hour", 55)],
  })
  assert.equal(resolveUsageLimitsAfterProbe({ published, probed: fresh }), fresh)
})

test("a wait reads as a wait, at every size", () => {
  assert.equal(formatResetWait(30_000), "1m")
  assert.equal(formatResetWait(45 * 60_000), "45m")
  assert.equal(formatResetWait(2 * 60 * 60_000), "2h")
  assert.equal(formatResetWait((2 * 60 + 13) * 60_000), "2h 13m")
})
