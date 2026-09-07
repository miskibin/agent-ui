// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * Tiered match scoring for the app's own little pickers — today the composer's
 * `@` file menu.
 *
 * A single fuzzy score is what makes those menus feel random: `use-chat.ts`
 * typed as `chat` scores against `lib/chat-helpers.ts` on one axis, and which
 * of the two wins comes down to arithmetic nobody can predict. Tiers replace
 * that with an order a user can feel: an exact name, then a prefix, then a
 * match at a word boundary, then a match anywhere, and only then a scattered
 * subsequence. Within a tier the score refines (earlier is better, shorter is
 * better); across tiers it can never cross, because each tier's whole range is
 * held below the next one's floor.
 *
 * **Lower is better** — the tiers are distances, not points. Inputs must be
 * normalized (trimmed, lowercased) before they arrive: see
 * {@link normalizeSearchQuery}.
 */

/**
 * Every within-tier refinement is clamped below this, so tier order is a
 * property of the numbers rather than a hope about how long a path can be.
 */
const TIER_WIDTH = 10_000
/** Positional penalties stop counting here — well inside a tier's width. */
const MAX_POSITION = 512
/** So is the length penalty, which only ever breaks ties. */
const MAX_LENGTH_PENALTY = 64

export const MATCH_TIER = {
  exact: 0,
  prefix: TIER_WIDTH,
  boundary: TIER_WIDTH * 2,
  includes: TIER_WIDTH * 3,
  fuzzy: TIER_WIDTH * 4,
} as const

/** Where a match sits inside its tier, kept in range. */
function positionPenalty(index: number) {
  return Math.min(Math.max(index, 0), MAX_POSITION) * 2
}

/** Shorter candidates win a tie: `chat.ts` before `chat-helpers.ts`. */
function lengthPenalty(value: string, query: string) {
  return Math.min(MAX_LENGTH_PENALTY, Math.max(0, value.length - query.length))
}

/** Trimmed and lowercased, with an optional leading sigil (`@`, `/`) removed. */
export function normalizeSearchQuery(
  input: string,
  options: { trimLeadingPattern?: RegExp } = {}
): string {
  const trimmed = input.trim()
  if (!trimmed) return ""
  return (
    options.trimLeadingPattern
      ? trimmed.replace(options.trimLeadingPattern, "")
      : trimmed
  ).toLowerCase()
}

/**
 * Distance for a scattered match: every character of `query` appears in
 * `value` in order. Penalizes a late start, gaps between the hits and a long
 * span, so `mls` prefers `message-list.ts` to `models/settings.ts`. Null when
 * the characters are not all there, in order.
 */
export function scoreSubsequenceMatch(
  value: string,
  query: string
): number | null {
  if (!query) return 0

  let queryIndex = 0
  let firstMatchIndex = -1
  let previousMatchIndex = -1
  let gapPenalty = 0

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== query[queryIndex]) continue
    if (firstMatchIndex === -1) firstMatchIndex = index
    if (previousMatchIndex !== -1) gapPenalty += index - previousMatchIndex - 1
    previousMatchIndex = index
    queryIndex += 1
    if (queryIndex === query.length) {
      const span = index - firstMatchIndex + 1 - query.length
      return Math.min(
        TIER_WIDTH - 1,
        positionPenalty(firstMatchIndex) +
          Math.min(gapPenalty * 3, MAX_POSITION * 2) +
          Math.min(span, MAX_POSITION) +
          lengthPenalty(value, query)
      )
    }
  }

  return null
}

/** The earliest match that starts right after one of `markers`. */
function boundaryMatchIndex(
  value: string,
  query: string,
  markers: readonly string[]
): number | null {
  let best: number | null = null
  for (const marker of markers) {
    const index = value.indexOf(`${marker}${query}`)
    if (index === -1) continue
    const matchIndex = index + marker.length
    if (best === null || matchIndex < best) best = matchIndex
  }
  return best
}

export type QueryMatchInput = {
  /** Already trimmed and lowercased. */
  value: string
  /** Likewise. */
  query: string
  /** Tier floors; omit one to skip that tier entirely. */
  exactBase?: number
  prefixBase?: number
  boundaryBase?: number
  includesBase?: number
  fuzzyBase?: number
  /** What counts as the start of a word. */
  boundaryMarkers?: readonly string[]
}

/** The tier-and-refinement distance, or null when nothing matches. */
export function scoreQueryMatch(input: QueryMatchInput): number | null {
  const { value, query } = input
  if (!value || !query) return null

  if (input.exactBase !== undefined && value === query) return input.exactBase

  if (input.prefixBase !== undefined && value.startsWith(query)) {
    return input.prefixBase + lengthPenalty(value, query)
  }

  if (input.boundaryBase !== undefined) {
    const index = boundaryMatchIndex(
      value,
      query,
      input.boundaryMarkers ?? [" ", "-", "_", "/", ".", "\\"]
    )
    if (index !== null) {
      return input.boundaryBase + positionPenalty(index) + lengthPenalty(value, query)
    }
  }

  if (input.includesBase !== undefined) {
    const index = value.indexOf(query)
    if (index !== -1) {
      return input.includesBase + positionPenalty(index) + lengthPenalty(value, query)
    }
  }

  if (input.fuzzyBase !== undefined) {
    const fuzzy = scoreSubsequenceMatch(value, query)
    if (fuzzy !== null) return input.fuzzyBase + fuzzy
  }

  return null
}

export type RankedResult<T> = {
  item: T
  /** Lower is better. */
  score: number
  /** Decides ties, so two equal scores always order the same way. */
  tieBreaker: string
}

function compareRanked<T>(left: RankedResult<T>, right: RankedResult<T>) {
  const delta = left.score - right.score
  if (delta !== 0) return delta
  return left.tieBreaker.localeCompare(right.tieBreaker)
}

/** Binary search for where `candidate` belongs in an already-sorted list. */
function insertionIndex<T>(
  ranked: RankedResult<T>[],
  candidate: RankedResult<T>
) {
  let low = 0
  let high = ranked.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (compareRanked(candidate, ranked[middle]) < 0) high = middle
    else low = middle + 1
  }
  return low
}

/**
 * Keeps the best `limit` results as they are produced, in order.
 *
 * The alternative is scoring every file, sorting the lot and slicing twenty
 * rows off the front — an O(n log n) pass over a whole checkout on every
 * keystroke. This is one binary search and one splice per candidate, and it
 * discards anything that cannot reach the list without touching it again.
 */
export function insertRankedResult<T>(
  ranked: RankedResult<T>[],
  candidate: RankedResult<T>,
  limit: number
): void {
  if (limit <= 0) return
  const index = insertionIndex(ranked, candidate)
  if (ranked.length < limit) {
    ranked.splice(index, 0, candidate)
    return
  }
  if (index >= limit) return
  ranked.splice(index, 0, candidate)
  ranked.pop()
}
