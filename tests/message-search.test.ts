import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildSnippet,
  searchMessages,
  searchableMessages,
  type SearchableMessage,
} from "@/lib/message-search"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"

/**
 * Message-content search behind the command palette's Messages group: what is
 * searchable, how the hits are ordered, and what the snippet hands the browser
 * to highlight.
 *
 * Everything here is `lib/message-search`'s own logic — the route that reads
 * the store and caches the projections supplies the two things this takes,
 * an index and a loader, which the tests supply from literals.
 */

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 7, 12)

function session(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    pinned: false,
    order: 0,
    providerId: "mock",
    model: "",
    createdAt: 0,
    updatedAt: NOW,
    messageCount: 2,
    ...extra,
  }
}

function user(id: string, content: string, typedText?: string): StoredMessage {
  return {
    id,
    sender: "user",
    content,
    ...(typedText ? { metadata: { typedText } } : null),
  }
}

function assistant(id: string, content: string): StoredMessage {
  return { id, sender: "assistant", content }
}

/** The index plus one transcript per chat, wired the way the route wires it. */
function store(threads: Record<string, StoredMessage[]>, meta: Partial<SessionMeta>[] = []) {
  const overrides = new Map(meta.map((entry) => [entry.id, entry]))
  const index = Object.keys(threads).map((id) =>
    session(id, overrides.get(id) ?? {})
  )
  const loadThread = (chat: SessionMeta): SearchableMessage[] =>
    searchableMessages(threads[chat.id] ?? [])
  return { index, loadThread }
}

/* -------------------------------------------------------------------------- */
/* What is searchable                                                          */
/* -------------------------------------------------------------------------- */

test("a user turn is searched by what was typed, not by what was sent", () => {
  const searchable = searchableMessages([
    user(
      "m1",
      "read this file\n\n```ts\nconst hidden = 'kubernetes'\n```",
      "read this file"
    ),
  ])
  assert.deepEqual(searchable, [
    { id: "m1", role: "user", text: "read this file" },
  ])
})

test("a user turn stored before typedText existed falls back to its content", () => {
  assert.deepEqual(searchableMessages([user("m1", "plain old prompt")]), [
    { id: "m1", role: "user", text: "plain old prompt" },
  ])
})

test("thinking and tool blocks are not searchable, the answer text is", () => {
  const message: StoredMessage = {
    id: "m1",
    sender: "assistant",
    content: "The port was already bound.",
    parts: [
      { type: "thinking", id: "t1", text: "maybe the daemon is stale" },
      {
        type: "tool",
        id: "c1",
        tool: { id: "c1", name: "Bash", status: "done", output: "lsof -i :3000" },
      },
      { type: "text", id: "x1", text: "The port was already bound." },
    ],
  }
  assert.deepEqual(searchableMessages([message]), [
    { id: "m1", role: "assistant", text: "The port was already bound." },
  ])
})

test("the app's own ask-answer turns are not searchable", () => {
  const messages: StoredMessage[] = [
    user("m1", "AskQuestion result: skipped"),
    user("m2", 'AskQuestion result: {"choice":"yes"}'),
    { ...user("m3", "flagged as internal"), internal: true },
    user("m4", "a real prompt"),
  ]
  assert.deepEqual(
    searchableMessages(messages).map((message) => message.id),
    ["m4"]
  )
})

test("whitespace is collapsed, so a query typed on one line matches wrapped text", async () => {
  const { index, loadThread } = store({
    a: [assistant("m1", "the docker\n   compose file")],
  })
  const result = await searchMessages({
    index,
    loadThread,
    query: "docker compose",
  })
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].snippet, "the docker compose file")
})

/* -------------------------------------------------------------------------- */
/* The query itself                                                            */
/* -------------------------------------------------------------------------- */

test("a one-character query searches nothing", async () => {
  const { index, loadThread } = store({ a: [user("m1", "docker")] })
  const result = await searchMessages({ index, loadThread, query: "d" })
  assert.deepEqual(result, { query: "d", matches: [], hasMore: false })
})

test("matching is case-insensitive and the query is normalized", async () => {
  const { index, loadThread } = store({ a: [user("m1", "Kubernetes ingress")] })
  const result = await searchMessages({
    index,
    loadThread,
    query: "  KUBERNETES  ",
  })
  assert.equal(result.query, "kubernetes")
  assert.equal(result.matches[0]?.messageId, "m1")
})

test("a multi-word query falls back to all terms, anywhere", async () => {
  const { index, loadThread } = store({
    phrase: [user("m1", "the retry budget was exhausted")],
    terms: [user("m2", "retry once, then give up on the whole budget")],
    neither: [user("m3", "the budget was fine")],
  })
  const result = await searchMessages({
    index,
    loadThread,
    query: "retry budget",
  })
  assert.deepEqual(
    result.matches.map((match) => match.sessionId),
    ["phrase", "terms"]
  )
})

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

test("a tighter tier outranks a looser one, whatever the recency", async () => {
  const { index, loadThread } = store(
    {
      middle: [user("m1", "rerunmigrations after the deploy")],
      boundary: [user("m2", "we should run migrations after the deploy")],
      prefix: [user("m3", "migrations are the slow part")],
    },
    [
      { id: "middle", updatedAt: NOW },
      { id: "boundary", updatedAt: NOW - DAY },
      { id: "prefix", updatedAt: NOW - 30 * DAY },
    ]
  )
  const result = await searchMessages({
    index,
    loadThread,
    query: "migrations",
  })
  assert.deepEqual(
    result.matches.map((match) => match.sessionId),
    ["prefix", "boundary", "middle"]
  )
})

test("inside one tier the most recently touched chat comes first", async () => {
  const { index, loadThread } = store(
    {
      old: [user("m1", "the flaky test is back")],
      recent: [user("m2", "chasing the flaky test again")],
      middle: [user("m3", "a flaky test, once more")],
    },
    [
      { id: "old", updatedAt: NOW - 10 * DAY },
      { id: "recent", updatedAt: NOW },
      { id: "middle", updatedAt: NOW - DAY },
    ]
  )
  const result = await searchMessages({ index, loadThread, query: "flaky" })
  assert.deepEqual(
    result.matches.map((match) => match.sessionId),
    ["recent", "middle", "old"]
  )
})

test("inside one chat the question outranks the answer that matched too", async () => {
  const { index, loadThread } = store({
    a: [
      user("m1", "why does the sandbox refuse to start"),
      assistant("m2", "sandbox refuses to start when it runs as root"),
    ],
  })
  const result = await searchMessages({ index, loadThread, query: "sandbox" })
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].messageId, "m1")
  assert.equal(result.matches[0].role, "user")
})

test("one chat contributes one row, however many of its turns matched", async () => {
  const { index, loadThread } = store({
    a: [
      assistant("m1", "cache warming happens on boot"),
      assistant("m2", "cache warming is also idempotent"),
    ],
  })
  const result = await searchMessages({ index, loadThread, query: "warming" })
  assert.equal(result.matches.length, 1)
  // Among equals the newest turn is the one worth going back to.
  assert.equal(result.matches[0].messageId, "m2")
})

test("hasMore says the list is the top of a longer one", async () => {
  const threads: Record<string, StoredMessage[]> = {}
  for (let n = 0; n < 5; n += 1) threads[`s${n}`] = [user(`m${n}`, "a token budget")]
  const { index, loadThread } = store(threads)

  const capped = await searchMessages({ index, loadThread, query: "budget", limit: 3 })
  assert.equal(capped.matches.length, 3)
  assert.equal(capped.hasMore, true)

  const whole = await searchMessages({ index, loadThread, query: "budget", limit: 5 })
  assert.equal(whole.matches.length, 5)
  assert.equal(whole.hasMore, false)
})

/* -------------------------------------------------------------------------- */
/* Snippets                                                                    */
/* -------------------------------------------------------------------------- */

test("a short message is its own snippet, with the match marked", () => {
  const { snippet, ranges } = buildSnippet("the retry budget ran out", ["retry"])
  assert.equal(snippet, "the retry budget ran out")
  assert.deepEqual(ranges, [{ start: 4, end: 9 }])
})

test("a long message is windowed around the first match and ellipsised", () => {
  const lead = "x".repeat(400)
  const tail = "y".repeat(400)
  const { snippet, ranges } = buildSnippet(`${lead} needle ${tail}`, ["needle"])

  assert.ok(snippet.startsWith("…"), snippet)
  assert.ok(snippet.endsWith("…"), snippet)
  assert.ok(snippet.length <= 122, `snippet was ${snippet.length}`)
  assert.equal(ranges.length, 1)
  assert.equal(
    snippet.slice(ranges[0].start, ranges[0].end),
    "needle",
    "the offsets must index into the snippet, ellipsis included"
  )
})

test("a match near the end keeps the window inside the text", () => {
  const { snippet, ranges } = buildSnippet(`${"x".repeat(400)} needle`, ["needle"])
  assert.ok(snippet.startsWith("…"), snippet)
  assert.ok(!snippet.endsWith("…"), snippet)
  assert.equal(snippet.slice(ranges[0].start, ranges[0].end), "needle")
})

test("every occurrence is marked, and overlapping terms merge into one range", () => {
  const both = buildSnippet("retry the retry budget", ["retry"])
  assert.deepEqual(both.ranges, [
    { start: 0, end: 5 },
    { start: 10, end: 15 },
  ])

  const merged = buildSnippet("the retrying budget", ["retry", "retrying"])
  assert.deepEqual(merged.ranges, [{ start: 4, end: 12 }])
})

test("a case-folded match is marked at the offsets of the original casing", () => {
  const { snippet, ranges } = buildSnippet("The Retry Budget", ["retry"])
  assert.equal(snippet.slice(ranges[0].start, ranges[0].end), "Retry")
})

test("a hit carries the chat's updatedAt, for the row's relative time", async () => {
  const { index, loadThread } = store({ a: [user("m1", "one more thing")] }, [
    { id: "a", updatedAt: NOW - 3 * DAY },
  ])
  const result = await searchMessages({ index, loadThread, query: "more" })
  assert.equal(result.matches[0].updatedAt, NOW - 3 * DAY)
})
