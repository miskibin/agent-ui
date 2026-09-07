// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * Subscription usage windows, and the rule for folding a partial update into
 * what a provider already published.
 *
 * A harness learns about its own quota from two sources that disagree in
 * shape: a full read taken once (every window at once, percentages and ISO
 * reset times) and the sparse notices a run streams while it is happening
 * (one window at a time, often with a field or two missing). Reconciling them
 * is the whole point of this file — a streamed notice must never blank a
 * field the full read established, and a repeat that says nothing new must
 * not allocate a new snapshot, because these arrive beside every token tick.
 *
 * Pure and free of `node:` on purpose: the claude-code translator folds
 * updates as it reads lines, and the tests drive the same functions with
 * recorded ones.
 */

export type UsageWindowKind = "session" | "weekly" | "monthly" | "other"

/** One quota window — "5-hour", "7-day", a model-scoped weekly. */
export type ProviderUsageWindow = {
  /** Stable across both sources, so an update lands on the row a read drew. */
  id: string
  kind: UsageWindowKind
  label: string
  /** 0–100, whatever the source's own scale was. */
  usedPercent: number
  /** ISO 8601, when the source said when the window reopens. */
  resetsAt?: string
  windowDurationMins?: number
}

export type ProviderUsageLimits = {
  /** ISO 8601 instant this snapshot was taken. */
  checkedAt: string
  windows: ProviderUsageWindow[]
  unavailable?: {
    /** `unsupported` is authoritative; `probeFailed` is "ask again later". */
    reason: "unsupported" | "probeFailed"
    message?: string
  }
}

/** The sparse half: the windows one streamed notice named. */
export type ProviderUsageLimitsUpdate = {
  windows: ProviderUsageWindow[]
}

const WINDOW_KIND_ORDER: Record<UsageWindowKind, number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
}

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
}

function sortWindows(windows: Iterable<ProviderUsageWindow>) {
  return [...windows].sort(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id)
  )
}

export function makeUsageLimits(input: {
  checkedAt: string
  windows: Iterable<ProviderUsageWindow>
}): ProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) }
}

export function makeUnavailableUsageLimits(input: {
  checkedAt: string
  reason: "unsupported" | "probeFailed"
  message?: string
}): ProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : null),
    },
  }
}

/**
 * Folds a sparse update into what is already published. Windows upsert by
 * `id`; one the update omits keeps its previous values, and one that arrives
 * without `resetsAt` or `windowDurationMins` keeps whatever the full read
 * resolved for it. An update with no windows leaves `previous` untouched.
 *
 * An `unsupported` snapshot stays unsupported: an account that cannot have
 * subscription windows will not start reporting them mid-turn.
 */
export function applyUsageLimitsUpdate(input: {
  previous: ProviderUsageLimits | undefined
  update: ProviderUsageLimitsUpdate
  checkedAt: string
}): ProviderUsageLimits | undefined {
  const { previous, update } = input
  if (
    update.windows.length === 0 ||
    previous?.unavailable?.reason === "unsupported"
  ) {
    return previous
  }
  const merged = new Map(
    (previous?.windows ?? []).map((window) => [window.id, window] as const)
  )
  // These ride along with every usage tick, almost always with unchanged
  // numbers. Decide "nothing changed" per window on the way through, so the
  // no-op case never allocates a new snapshot.
  let changed = false
  for (const window of update.windows) {
    const existing = merged.get(window.id)
    const next: ProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : null),
      ...(window.windowDurationMins === undefined &&
      existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : null),
    }
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next)
      changed = true
    }
  }
  if (!changed && previous !== undefined && previous.unavailable === undefined) {
    return previous
  }
  return makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() })
}

function usageWindowEquals(
  a: ProviderUsageWindow,
  b: ProviderUsageWindow
): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  )
}

/**
 * What to publish once a full read finishes. A read that failed this time
 * must not wipe rows an earlier read or a running turn already established,
 * so the last good snapshot stays; `unsupported` is authoritative and
 * replaces them. A successful read replaces the windows outright, including
 * an update that landed while it was running — the next streamed notice
 * corrects that sub-second staleness on its own.
 */
export function resolveUsageLimitsAfterProbe(input: {
  published: ProviderUsageLimits | undefined
  probed: ProviderUsageLimits | undefined
}): ProviderUsageLimits | undefined {
  const { published, probed } = input
  if (
    probed?.unavailable?.reason === "probeFailed" &&
    published &&
    !published.unavailable
  ) {
    return published
  }
  return probed
}

/**
 * `2h 13m`, `45m`, `3h` — the remaining wait, never a wall clock. This is
 * rendered where the run happens and read wherever the user is, which may be
 * another timezone and another locale; a wait reads the same everywhere.
 */
export function formatResetWait(waitMs: number): string {
  const totalMinutes = Math.ceil(waitMs / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${totalMinutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}
