// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * "Put this chat down until…" — the choices the sidebar offers and the labels
 * that describe the result.
 *
 * Pure, timestamp in and string out, so the whole thing is unit-testable and
 * so the sidebar can resolve the presets at the moment the menu opens rather
 * than at render time: a popover built an hour ago would otherwise offer "in 1
 * hour" meaning an hour ago.
 *
 * Every calendar step goes through `setDate` / `setHours` rather than adding
 * milliseconds. A fixed 24h offset lands on the wrong local day across a DST
 * transition — a spring-forward day is 23 hours long, so 23:30 + 24h skips the
 * next day entirely — and the whole point of "tomorrow morning" is the day.
 */

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

/** Evening is 17:30: late enough to be after the working day, early enough to act on. */
const EVENING_HOUR = 17
const EVENING_MINUTE = 30
/** Every calendar preset lands on 9:00 of its day. */
const MORNING_HOUR = 9

/**
 * Weekday and month names are spelled here rather than taken from `Intl`: the
 * label goes into a sidebar row three words wide, and it must read the same on
 * a machine whose locale would otherwise print "pon." or a 12-hour clock.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

export type SnoozePresetId =
  | "hour"
  | "three-hours"
  | "evening"
  | "tomorrow"
  | "next-week"

export type SnoozePreset = {
  id: SnoozePresetId
  /** What the row says — "Tomorrow". */
  label: string
  /** The time column beside it — "9:00". It complements the label, never repeats it. */
  when: string
  /** The wake time itself, in epoch milliseconds. */
  until: number
}

/** 24-hour clock, unpadded hour: `17:30`, `9:00`. */
export function timeLabel(at: number | Date): string {
  const date = at instanceof Date ? at : new Date(at)
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`
}

function atTime(base: Date, hour: number, minute = 0): Date {
  const next = new Date(base)
  next.setHours(hour, minute, 0, 0)
  return next
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base)
  next.setDate(next.getDate() + days)
  return next
}

/**
 * The choices, resolved against the moment the menu opened.
 *
 * "This evening" is dropped once the evening is less than an hour away — a
 * choice that means "in forty minutes" is already covered by "in 1 hour", and
 * one that means "in the past" is a trap. "Next week" is always the *coming*
 * Monday, which on a Monday is a full week ahead rather than today, and it is
 * dropped when it would land on the same instant as "Tomorrow" (Sundays).
 */
export function snoozePresets(now: number = Date.now()): SnoozePreset[] {
  const base = new Date(now)
  const inAnHour = now + HOUR_MS
  const inThreeHours = now + 3 * HOUR_MS

  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      when: timeLabel(inAnHour),
      until: inAnHour,
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      when: timeLabel(inThreeHours),
      until: inThreeHours,
    },
  ]

  const evening = atTime(base, EVENING_HOUR, EVENING_MINUTE).getTime()
  if (evening - now > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      when: timeLabel(evening),
      until: evening,
    })
  }

  const tomorrow = atTime(addDays(base, 1), MORNING_HOUR).getTime()
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    when: timeLabel(tomorrow),
    until: tomorrow,
  })

  // `|| 7` is the whole "a full week on Mondays" rule: on a Monday the
  // remainder is 0, and "next week" must not mean "in a moment".
  const daysUntilMonday = (1 - base.getDay() + 7) % 7 || 7
  const nextWeek = atTime(addDays(base, daysUntilMonday), MORNING_HOUR).getTime()
  if (nextWeek !== tomorrow) {
    presets.push({
      id: "next-week",
      label: "Next week",
      when: `${WEEKDAYS[new Date(nextWeek).getDay()]} ${timeLabel(nextWeek)}`,
      until: nextWeek,
    })
  }

  return presets
}

/**
 * The wake time as a sentence fragment: `17:30` today, `tomorrow 9:00`,
 * `Mon 9:00` inside the week, `Apr 3, 9:00` beyond it. Used by the menu's
 * confirmation and by the row that says when a snoozed chat comes back.
 */
export function snoozeWakeDescription(
  until: number,
  now: number = Date.now()
): string {
  if (!Number.isFinite(until)) return ""
  const wake = new Date(until)
  const time = timeLabel(wake)
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  // Whole calendar days apart, which is the difference a person means by
  // "tomorrow" — not 24-hour blocks.
  const days = Math.floor((until - startOfToday.getTime()) / DAY_MS)
  if (days <= 0) return time
  if (days === 1) return `tomorrow ${time}`
  if (days < 7) return `${WEEKDAYS[wake.getDay()]} ${time}`
  return `${MONTHS[wake.getMonth()]} ${wake.getDate()}, ${time}`
}
