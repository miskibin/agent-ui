// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

import {
  MATCH_TIER,
  insertRankedResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedResult,
} from "@/lib/search-ranking"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"

/**
 * Searching what was *said*, not just what a chat is called.
 *
 * The palette has always matched titles, which is the one thing a chat is
 * least likely to be remembered by: a title is generated, and the sentence the
 * user actually types is "the docker compose thing that kept OOMing". So this
 * walks the stored transcripts and answers with the one message per chat that
 * best matches, ready to render — a snippet with the offsets to mark inside
 * it, so the browser never has to re-find the match it was already given.
 *
 * Pure, and free of `node:` and of React, exactly like `lib/usage`: the route
 * behind it (`app/api/search`) supplies the transcripts and owns the caching,
 * and `tests/message-search.test.ts` supplies them from literals.
 *
 * What is searched is deliberately narrow — the user's own words
 * (`metadata.typedText`, the same field the memory extractor is held to) and
 * the assistant's answer text. Never thinking, never tool input or output:
 * a grep over tool output finds every chat that ever ran `ls`, and the file
 * a tool touched is already searchable in the file panel.
 */

export type MessageSearchRole = "user" | "assistant"

/** One message reduced to the only three things a search needs. */
export type SearchableMessage = {
  id: string
  role: MessageSearchRole
  /**
   * Whitespace already collapsed to single spaces — a query typed on one
   * line has to match an answer that wrapped over three, and a snippet cut
   * out of it must not carry a paragraph break into a one-line row.
   */
  text: string
}

/** A half-open `[start, end)` slice of a snippet to wrap in `<mark>`. */
export type MessageSearchRange = { start: number; end: number }

export type MessageSearchHit = {
  sessionId: string
  messageId: string
  role: MessageSearchRole
  /** ~120 characters of `text` centred on the first match, ellipsised. */
  snippet: string
  /** Where the query sits inside `snippet`, merged and in order. */
  ranges: MessageSearchRange[]
  /** The chat's `updatedAt` — the recency that breaks ties. */
  updatedAt: number
}

export type MessageSearchResult = {
  /** The normalized query, echoed so a late answer can be matched to it. */
  query: string
  matches: MessageSearchHit[]
  /** More chats matched than `limit` — the list is the top of a longer one. */
  hasMore: boolean
}

/** Below this a query matches half the store; the palette does not search. */
export const MIN_SEARCH_QUERY = 2
export const DEFAULT_SEARCH_LIMIT = 8
export const MAX_SEARCH_LIMIT = 50

/** Body of a snippet, before the ellipses that mark where it was cut. */
const SNIPPET_CHARS = 120
/** How much of it sits *before* the match, so there is context on both sides. */
const SNIPPET_LEAD = 32

/**
 * One tier block, from `lib/search-ranking`'s own constants. Used to drop a
 * score to its tier floor: inside a message body the refinement (how far in
 * the match sits, how long the message is) is noise — a phrase 400 characters
 * into an answer is not a worse hit than the same phrase at character 12 —
 * and dropping it is what lets recency do the ordering it should.
 */
const TIER_WIDTH = MATCH_TIER.prefix

/**
 * Prose word starts. The default set is built for paths; a sentence breaks on
 * punctuation and brackets too, and a match right after one of those reads as
 * a whole-word hit rather than a fragment.
 */
const PROSE_BOUNDARIES = [
  " ",
  "-",
  "_",
  "/",
  ".",
  ",",
  ";",
  ":",
  "(",
  "[",
  "{",
  "<",
  '"',
  "'",
  "`",
  "*",
  "#",
  "!",
  "?",
] as const

/**
 * Within one chat a question the user asked outranks any answer, however well
 * the answer matches — that is the message they are trying to get back to.
 * A whole tier block above the last one, so the preference can never be
 * out-scored from inside a tier.
 */
const ASSISTANT_TIER_OFFSET = MATCH_TIER.fuzzy + TIER_WIDTH

/**
 * Mirrors `isInternalMessage` in `lib/ask-tools`. Duplicated rather than
 * imported on purpose: that module pulls the ask-question helpers out of a
 * `.tsx` component, which the type-stripping test runner cannot parse, and
 * this file has to stay loadable by `node --test`. Keep the two in step.
 */
const ASK_ANSWER_PREFIX = "AskQuestion result: "
const ASK_ANSWER_SKIPPED = `${ASK_ANSWER_PREFIX}skipped`

function isInternal(message: StoredMessage) {
  if (message.internal) return true
  return (
    message.sender === "user" &&
    (message.content === ASK_ANSWER_SKIPPED ||
      message.content.startsWith(`${ASK_ANSWER_PREFIX}{`))
  )
}

/**
 * Lowercased for matching, but never a *different length*: a snippet's
 * highlight offsets index into the original text, and `"İ".toLowerCase()` is
 * two characters. When the locale fold would move them, an ASCII-only fold —
 * which cannot — is used instead.
 */
function fold(text: string) {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  return text.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

function collapse(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * What one message contributes. A user turn is read from `metadata.typedText`
 * — what the person actually wrote, before the composer fenced an attachment
 * or a skill prefix into the prompt — falling back to the stored content for
 * turns kept before that field existed. An assistant turn is its text parts;
 * `content` accumulates exactly those while streaming, so it is the fallback
 * rather than the source, and thinking and tool blocks are in neither.
 */
function messageText(message: StoredMessage): string {
  if (message.sender === "user") {
    return collapse(message.metadata?.typedText ?? message.content ?? "")
  }
  const parts = message.parts
  if (parts?.length) {
    const text = collapse(
      parts
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(" ")
    )
    if (text) return text
  }
  return collapse(message.content ?? "")
}

/**
 * The searchable projection of one transcript — small enough to cache, which
 * is the whole reason it is a separate step: `app/api/search` holds this and
 * never the messages it came from.
 */
export function searchableMessages(
  messages: StoredMessage[]
): SearchableMessage[] {
  const searchable: SearchableMessage[] = []
  for (const message of messages) {
    if (isInternal(message)) continue
    const text = messageText(message)
    if (!text) continue
    searchable.push({ id: message.id, role: message.sender, text })
  }
  return searchable
}

/** Roughly how much memory one projection holds, for a size-aware cache. */
export function searchableSize(messages: SearchableMessage[]) {
  let size = 0
  for (const message of messages) size += message.text.length + message.id.length
  return size
}

/** The tier a distance landed in, with its within-message refinement dropped. */
function tierOf(score: number) {
  return Math.floor(score / TIER_WIDTH) * TIER_WIDTH
}

/**
 * How well one message answers the query, and what to highlight in it.
 *
 * The whole query as one string comes first — the phrase someone half
 * remembers is the phrase they type — through the same tiers every other
 * picker in the app uses: a prefix, then a word boundary, then anywhere.
 * Only when that fails does a multi-word query fall back to "every term is
 * in here somewhere", which is the bottom tier because the terms may be
 * paragraphs apart. There is deliberately no subsequence tier: scattered
 * letters over a page of prose match everything.
 */
function scoreText(
  folded: string,
  query: string,
  terms: string[]
): { score: number; needles: string[] } | null {
  const whole = scoreQueryMatch({
    value: folded,
    query,
    prefixBase: MATCH_TIER.prefix,
    boundaryBase: MATCH_TIER.boundary,
    includesBase: MATCH_TIER.includes,
    boundaryMarkers: PROSE_BOUNDARIES,
  })
  if (whole !== null) return { score: tierOf(whole), needles: [query] }
  if (terms.length < 2) return null
  if (!terms.every((term) => folded.includes(term))) return null
  return { score: MATCH_TIER.fuzzy, needles: terms }
}

/** Every occurrence of every needle, in order, with overlaps merged. */
function highlightRanges(
  folded: string,
  needles: string[],
  offset: number
): MessageSearchRange[] {
  const found: MessageSearchRange[] = []
  for (const needle of needles) {
    if (!needle) continue
    let at = folded.indexOf(needle)
    while (at !== -1) {
      found.push({ start: at + offset, end: at + needle.length + offset })
      at = folded.indexOf(needle, at + needle.length)
    }
  }
  found.sort((left, right) => left.start - right.start || left.end - right.end)

  const merged: MessageSearchRange[] = []
  for (const range of found) {
    const last = merged.at(-1)
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

/** The earliest position any needle reaches, or 0 when none do. */
function firstMatchIndex(folded: string, needles: string[]) {
  let first = -1
  for (const needle of needles) {
    const at = folded.indexOf(needle)
    if (at === -1) continue
    if (first === -1 || at < first) first = at
  }
  return first === -1 ? 0 : first
}

/**
 * A window of `text` around its first match. Ported from T3 Code's
 * `buildSearchSnippet`: keep the match off the left edge, never run past
 * either end, and say with an ellipsis wherever the text was cut.
 */
export function buildSnippet(
  text: string,
  needles: string[]
): { snippet: string; ranges: MessageSearchRange[] } {
  const folded = fold(text)
  if (text.length <= SNIPPET_CHARS) {
    return { snippet: text, ranges: highlightRanges(folded, needles, 0) }
  }

  const ideal = Math.max(0, firstMatchIndex(folded, needles) - SNIPPET_LEAD)
  const start = Math.max(0, Math.min(ideal, text.length - SNIPPET_CHARS))
  const end = Math.min(text.length, start + SNIPPET_CHARS)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < text.length ? "…" : ""
  const body = text.slice(start, end)
  return {
    snippet: `${prefix}${body}${suffix}`,
    ranges: highlightRanges(folded.slice(start, end), needles, prefix.length),
  }
}

/**
 * The one message in a chat worth showing. A user turn beats an answer, and
 * among equals the most recent one wins — the same order T3 Code's SQL picks
 * a thread's representative row in.
 */
function bestMessage(
  messages: SearchableMessage[],
  query: string,
  terms: string[]
) {
  let best: {
    message: SearchableMessage
    score: number
    needles: string[]
  } | null = null

  for (const message of messages) {
    const scored = scoreText(fold(message.text), query, terms)
    if (!scored) continue
    const ranked =
      scored.score + (message.role === "assistant" ? ASSISTANT_TIER_OFFSET : 0)
    if (best !== null) {
      const bestRanked =
        best.score + (best.message.role === "assistant" ? ASSISTANT_TIER_OFFSET : 0)
      if (ranked > bestRanked) continue
    }
    best = { message, score: scored.score, needles: scored.needles }
  }
  return best
}

export type MessageSearchInput = {
  /** The sidebar index, already narrowed to what is worth walking. */
  index: SessionMeta[]
  /**
   * One chat's searchable projection. Returning the projection rather than
   * the transcript is what lets `app/api/search` cache the small thing.
   */
  loadThread: (
    session: SessionMeta
  ) => SearchableMessage[] | Promise<SearchableMessage[]>
  query: string
  limit?: number
}

/**
 * The best `limit` chats whose messages match, newest first inside a tier.
 *
 * Ordering is the tier and then recency, and nothing else. A tighter match
 * always wins — a chat where the phrase opens a sentence beats one where it
 * sits mid-word — but two chats that matched the same way are ordered by when
 * they were last touched, because between two equally good hits the recent
 * one is the one being looked for.
 */
export async function searchMessages({
  index,
  loadThread,
  query,
  limit = DEFAULT_SEARCH_LIMIT,
}: MessageSearchInput): Promise<MessageSearchResult> {
  const normalized = normalizeSearchQuery(query)
  const terms = normalized.split(/\s+/).filter(Boolean)
  const whole = terms.join(" ")
  if (whole.length < MIN_SEARCH_QUERY) {
    return { query: whole, matches: [], hasMore: false }
  }

  const cap = Math.max(1, Math.min(Math.trunc(limit), MAX_SEARCH_LIMIT))
  const perChat = await Promise.all(
    index.map(async (session) => ({
      session,
      best: bestMessage(await loadThread(session), whole, terms),
    }))
  )

  // Bounded insertion rather than sort-then-slice, the same way the `@` menu
  // ranks a checkout: only `cap` of these are ever rendered.
  const ranked: RankedResult<MessageSearchHit>[] = []
  let found = 0
  for (const { session, best } of perChat) {
    if (!best) continue
    found += 1
    const { snippet, ranges } = buildSnippet(best.message.text, best.needles)
    insertRankedResult(
      ranked,
      {
        item: {
          sessionId: session.id,
          messageId: best.message.id,
          role: best.message.role,
          snippet,
          ranges,
          updatedAt: session.updatedAt,
        },
        score: best.score,
        tieBreaker: recencyKey(session),
      },
      cap
    )
  }

  return {
    query: whole,
    matches: ranked.map((entry) => entry.item),
    hasMore: found > cap,
  }
}

/**
 * A tie-breaker that sorts newest first. `insertRankedResult` compares ties as
 * strings, so the timestamp is inverted and zero-padded to a fixed width, and
 * the session id is appended to keep the order total.
 */
const MAX_TIMESTAMP = 10 ** 15

function recencyKey(session: SessionMeta) {
  const inverted = Math.max(0, MAX_TIMESTAMP - (session.updatedAt || 0))
  return `${String(inverted).padStart(16, "0")}:${session.id}`
}
