import assert from "node:assert/strict"
import { test } from "node:test"

import {
  MATCH_TIER,
  insertRankedResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  scoreSubsequenceMatch,
  type RankedResult,
} from "@/lib/search-ranking"

/**
 * The order the composer's `@` menu puts files in. Lower is better, and the
 * point of the tiers is that no amount of within-tier refinement can push a
 * substring match past a prefix one.
 */

const tiers = {
  exactBase: MATCH_TIER.exact,
  prefixBase: MATCH_TIER.prefix,
  boundaryBase: MATCH_TIER.boundary,
  includesBase: MATCH_TIER.includes,
  fuzzyBase: MATCH_TIER.fuzzy,
}

function score(value: string, query: string) {
  return scoreQueryMatch({ value, query, ...tiers })
}

test("the query is trimmed, lowercased and stripped of its sigil", () => {
  assert.equal(normalizeSearchQuery("  Chat.TS "), "chat.ts")
  assert.equal(normalizeSearchQuery("@@chat", { trimLeadingPattern: /^@+/ }), "chat")
  assert.equal(normalizeSearchQuery("   "), "")
})

test("the tiers order exact, prefix, boundary, substring, subsequence", () => {
  const exact = score("chat", "chat")
  const prefix = score("chat-helpers", "chat")
  const boundary = score("use-chat", "chat")
  const includes = score("prechat", "chat")
  const fuzzy = score("cheap-hat", "chat")
  assert.ok(exact !== null && prefix !== null && boundary !== null)
  assert.ok(includes !== null && fuzzy !== null)
  const order = [exact, prefix, boundary, includes, fuzzy] as number[]
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], `${i}`)
})

test("no within-tier refinement can cross into the next tier", () => {
  const worstPrefix = score(`chat${"x".repeat(4_000)}`, "chat")
  assert.ok(worstPrefix !== null && worstPrefix < MATCH_TIER.boundary)
  const worstIncludes = score(`${"x/".repeat(2_000)}chat`, "chat")
  assert.ok(worstIncludes !== null && worstIncludes < MATCH_TIER.fuzzy)
})

test("inside a tier, earlier and shorter win", () => {
  assert.ok(score("chat.ts", "chat")! < score("chat-helpers.ts", "chat")!)
  assert.ok(score("a-chat", "chat")! < score("aaaa-chat", "chat")!)
})

test("a subsequence prefers a tight, early run", () => {
  const tight = scoreSubsequenceMatch("mails.ts", "mls")!
  assert.ok(tight < scoreSubsequenceMatch("my-long-settings.ts", "mls")!)
  assert.ok(tight < scoreSubsequenceMatch("zzzz-mails.ts", "mls")!)
  assert.equal(scoreSubsequenceMatch("abc", "acb"), null)
  assert.equal(scoreSubsequenceMatch("anything", ""), 0)
})

test("nothing matching is null, not zero", () => {
  assert.equal(score("chat", "zzz"), null)
  assert.equal(score("", "chat"), null)
  assert.equal(score("chat", ""), null)
})

test("bounded insertion keeps exactly the best N, in order", () => {
  const ranked: RankedResult<string>[] = []
  for (const [item, value] of [
    ["d", 40],
    ["b", 20],
    ["a", 10],
    ["e", 50],
    ["c", 30],
  ] as const) {
    insertRankedResult(ranked, { item, score: value, tieBreaker: item }, 3)
  }
  assert.deepEqual(ranked.map((entry) => entry.item), ["a", "b", "c"])
})

test("a tie is broken by the tie-breaker, and a full list refuses a worse entry", () => {
  const ranked: RankedResult<string>[] = []
  for (const item of ["zeta", "alpha", "mid"]) {
    insertRankedResult(ranked, { item, score: 1, tieBreaker: item }, 2)
  }
  assert.deepEqual(ranked.map((entry) => entry.item), ["alpha", "mid"])
  insertRankedResult(ranked, { item: "worse", score: 99, tieBreaker: "worse" }, 2)
  assert.deepEqual(ranked.map((entry) => entry.item), ["alpha", "mid"])
  // A limit of zero keeps nothing at all.
  const none: RankedResult<string>[] = []
  insertRankedResult(none, { item: "x", score: 0, tieBreaker: "x" }, 0)
  assert.deepEqual(none, [])
})
