import assert from "node:assert/strict"
import { test } from "node:test"

import type { SessionMeta, StoredMessage } from "@/lib/store/types"
import {
  NO_FOLDER_LABEL,
  buildUsageReport,
  chatUsage,
  formatTokens,
  usageTurns,
  withinWindow,
} from "@/lib/usage"

/**
 * The usage aggregation behind the header total and Settings → Usage: which
 * turns count, how they group, and — the part that matters most — the
 * difference between "costs nothing" and "cost unknown".
 */

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 0, 31, 12)

function session(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    pinned: false,
    order: 0,
    providerId: "mock",
    model: "",
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    ...extra,
  }
}

/** One assistant turn that reported usage. */
function turn(
  meta: Partial<NonNullable<StoredMessage["metadata"]>>,
  extra: Partial<StoredMessage> = {}
): StoredMessage {
  return {
    id: `m${Math.random().toString(36).slice(2)}`,
    content: "answer",
    sender: "assistant",
    metadata: { inputTokens: 100, outputTokens: 50, ...meta },
    ...extra,
  }
}

function report(
  sessions: SessionMeta[],
  messages: Record<string, StoredMessage[]>,
  days: number | null
) {
  return buildUsageReport(sessions, messages, days, NOW)
}

/* -------------------------------------------------------------------------- */
/* What counts as a turn                                                       */
/* -------------------------------------------------------------------------- */

test("only assistant turns carrying a token count are counted", () => {
  const turns = usageTurns({}, [
    { id: "u", content: "hi", sender: "user" },
    { id: "a1", content: "no metadata", sender: "assistant" },
    {
      id: "a2",
      content: "metadata without counts",
      sender: "assistant",
      metadata: { model: "openai/gpt-4o", responseTime: 2 },
    },
    turn({ model: "openai/gpt-4o", finishedAt: NOW }),
    // A user message is never a turn, even if something wrote counts onto it.
    {
      id: "u2",
      content: "hi",
      sender: "user",
      metadata: { inputTokens: 10, outputTokens: 10 },
    },
  ])

  assert.equal(turns.length, 1)
  assert.equal(turns[0].model, "openai/gpt-4o")
  assert.equal(turns[0].inputTokens, 100)
  assert.equal(turns[0].outputTokens, 50)
})

test("a turn reporting only one side of the split still counts", () => {
  const turns = usageTurns({}, [
    turn({ model: "openai/gpt-4o", inputTokens: 400, outputTokens: undefined }),
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].inputTokens, 400)
  assert.equal(turns[0].outputTokens, 0)
})

/* -------------------------------------------------------------------------- */
/* The window                                                                  */
/* -------------------------------------------------------------------------- */

test("the window keeps the turns inside it and drops the rest", () => {
  const messages = [
    turn({ model: "openai/gpt-4o", finishedAt: NOW - 2 * DAY }),
    turn({ model: "openai/gpt-4o", finishedAt: NOW - 10 * DAY }),
    turn({ model: "openai/gpt-4o", finishedAt: NOW - 200 * DAY }),
  ]
  const sessions = [session("a")]

  assert.equal(report(sessions, { a: messages }, 7).totals.turns, 1)
  assert.equal(report(sessions, { a: messages }, 30).totals.turns, 2)
  assert.equal(report(sessions, { a: messages }, null).totals.turns, 3)
})

test("a turn with no timestamp counts only when the window is all-time", () => {
  const undated = [turn({ model: "openai/gpt-4o", finishedAt: undefined })]
  const sessions = [session("a")]

  assert.equal(report(sessions, { a: undated }, 30).totals.turns, 0)
  assert.equal(report(sessions, { a: undated }, null).totals.turns, 1)
})

test("createdAt stands in for a turn stored before finishedAt existed", () => {
  const turns = usageTurns({}, [
    turn({ model: "openai/gpt-4o", finishedAt: undefined }, { createdAt: NOW }),
  ])
  assert.equal(turns[0].at, NOW)
  assert.equal(withinWindow(turns, NOW - DAY).length, 1)
})

/* -------------------------------------------------------------------------- */
/* Pricing                                                                     */
/* -------------------------------------------------------------------------- */

test("ollama is free, not unknown — it is priced, at zero", () => {
  const result = report(
    [session("a")],
    {
      a: [
        turn({
          model: "ollama/qwen3:8b",
          providerId: "ollama",
          finishedAt: NOW,
        }),
      ],
    },
    30
  )
  assert.equal(result.totals.turns, 1)
  assert.equal(result.totals.pricedTurns, 1)
  assert.equal(result.totals.unpricedTurns, 0)
  assert.equal(result.totals.cost, 0)
})

test("a bare id from claude-code is priced at Anthropic rates", () => {
  const result = report(
    [session("a")],
    {
      a: [
        turn({
          model: "opus",
          providerId: "claudeCode",
          inputTokens: 1_000_000,
          outputTokens: 0,
          finishedAt: NOW,
        }),
      ],
    },
    30
  )
  assert.equal(result.totals.pricedTurns, 1)
  // claude-opus-5 — $5 per million input.
  assert.equal(result.totals.cost, 5)
})

test("an unpriced turn is counted in tokens but left out of the cost", () => {
  const result = report(
    [session("a")],
    {
      a: [
        turn({ model: "openai/gpt-4o", finishedAt: NOW }),
        // A harness reselling a model it does not name a source for.
        turn({ model: "composer-2.5", providerId: "cursor", finishedAt: NOW }),
      ],
    },
    30
  )
  assert.equal(result.totals.turns, 2)
  assert.equal(result.totals.pricedTurns, 1)
  assert.equal(result.totals.unpricedTurns, 1)
  assert.equal(result.totals.tokens, 300)
  // gpt-4o: 100 in at $2.50/M + 50 out at $10/M.
  assert.ok(result.totals.cost != null)
  assert.ok(Math.abs((result.totals.cost as number) - 0.00075) < 1e-9)
})

test("a window in which nothing could be priced reports a null cost", () => {
  const result = report(
    [session("a")],
    { a: [turn({ model: "composer-2.5", providerId: "cursor", finishedAt: NOW })] },
    30
  )
  assert.equal(result.totals.turns, 1)
  assert.equal(result.totals.cost, null)
  assert.equal(result.models[0].cost, null)
})

/* -------------------------------------------------------------------------- */
/* Grouping                                                                    */
/* -------------------------------------------------------------------------- */

test("turns group per model, and the same model across chats sums", () => {
  const result = report(
    [session("a"), session("b")],
    {
      a: [
        turn({ model: "openai/gpt-4o", providerId: "chat", finishedAt: NOW }),
        turn({ model: "openai/gpt-4o", providerId: "chat", finishedAt: NOW }),
      ],
      b: [
        turn({
          model: "anthropic/claude-sonnet-4-6",
          providerId: "chat",
          finishedAt: NOW,
        }),
      ],
    },
    30
  )

  assert.equal(result.chats, 2)
  assert.equal(result.models.length, 2)
  const gpt = result.models.find((row) => row.model === "openai/gpt-4o")
  assert.equal(gpt?.turns, 2)
  assert.equal(gpt?.tokens, 300)
  // Sorted by spend, biggest first: two gpt-4o turns ($0.0015) come in ahead
  // of the single sonnet one ($0.00105).
  assert.equal(result.models[0].model, "openai/gpt-4o")
  assert.equal(result.models[1].model, "anthropic/claude-sonnet-4-6")
  assert.ok((result.models[0].cost ?? 0) > (result.models[1].cost ?? 0))
})

test("the same bare id on two harnesses stays two rows", () => {
  const result = report(
    [session("a")],
    {
      a: [
        turn({ model: "opus", providerId: "claudeCode", finishedAt: NOW }),
        turn({ model: "opus", providerId: "cursor", finishedAt: NOW }),
      ],
    },
    30
  )
  assert.equal(result.models.length, 2)
  assert.deepEqual(
    result.models.map((row) => row.providerId).sort(),
    ["claudeCode", "cursor"]
  )
})

test("turns group per folder, preferring the folder the run recorded", () => {
  const result = report(
    [session("a", { cwd: "/home/me/later" }), session("b", { cwd: "/home/me/api" })],
    {
      a: [
        // Recorded at the time of the run — an older folder than the chat's now.
        turn({ model: "openai/gpt-4o", cwd: "/home/me/web", finishedAt: NOW }),
        turn({ model: "openai/gpt-4o", finishedAt: NOW }),
      ],
      b: [turn({ model: "openai/gpt-4o", finishedAt: NOW })],
    },
    30
  )

  const byCwd = new Map(result.folders.map((row) => [row.cwd, row]))
  assert.deepEqual(
    [...byCwd.keys()].sort(),
    ["/home/me/api", "/home/me/later", "/home/me/web"]
  )
  assert.equal(byCwd.get("/home/me/web")?.label, "web")
  assert.equal(byCwd.get("/home/me/api")?.turns, 1)
})

test("chats without a folder land in one No folder row", () => {
  const result = report(
    [session("a"), session("b", { cwd: "   " })],
    {
      a: [turn({ model: "openai/gpt-4o", finishedAt: NOW })],
      b: [turn({ model: "openai/gpt-4o", finishedAt: NOW })],
    },
    30
  )
  assert.equal(result.folders.length, 1)
  assert.equal(result.folders[0].cwd, "")
  assert.equal(result.folders[0].label, NO_FOLDER_LABEL)
  assert.equal(result.folders[0].turns, 2)
})

test("a chat with no counted turn is not counted as a chat", () => {
  const result = report(
    [session("a"), session("empty")],
    { a: [turn({ model: "openai/gpt-4o", finishedAt: NOW })], empty: [] },
    30
  )
  assert.equal(result.chats, 1)
})

test("the report carries the window it answered for", () => {
  const windowed = report([session("a")], { a: [] }, 7)
  assert.equal(windowed.window.days, 7)
  assert.equal(windowed.window.since, NOW - 7 * DAY)

  const all = report([session("a")], { a: [] }, null)
  assert.equal(all.window.days, null)
  assert.equal(all.window.since, null)
})

test("lastTurnAt is the newest counted turn", () => {
  const result = report(
    [session("a")],
    {
      a: [
        turn({ model: "openai/gpt-4o", finishedAt: NOW - 3 * DAY }),
        turn({ model: "openai/gpt-4o", finishedAt: NOW - DAY }),
      ],
    },
    30
  )
  assert.equal(result.lastTurnAt, NOW - DAY)
})

/* -------------------------------------------------------------------------- */
/* One chat                                                                    */
/* -------------------------------------------------------------------------- */

test("chatUsage is null until a turn reports something", () => {
  assert.equal(chatUsage([]), null)
  assert.equal(chatUsage([{ id: "u", content: "hi", sender: "user" }]), null)
})

test("chatUsage sums the thread and breaks it down per model", () => {
  const usage = chatUsage([
    turn({ model: "openai/gpt-4o", providerId: "chat" }),
    turn({ model: "ollama/qwen3:8b", providerId: "ollama" }),
    turn({ model: "composer-2.5", providerId: "cursor" }),
  ])

  assert.ok(usage)
  assert.equal(usage.turns, 3)
  assert.equal(usage.tokens, 450)
  assert.equal(usage.unpricedTurns, 1)
  assert.equal(usage.pricedTurns, 2)
  assert.equal(usage.models.length, 3)
  // Windowless: an undated turn still counts for the open chat.
  assert.ok(usage.cost != null && usage.cost > 0)
})

test("formatTokens keeps the number readable at every size", () => {
  assert.equal(formatTokens(0), "0")
  assert.equal(formatTokens(999), "999")
  assert.equal(formatTokens(1200), "1.2k")
  assert.equal(formatTokens(12_400), "12k")
  assert.equal(formatTokens(1_250_000), "1.25M")
  assert.equal(formatTokens(12_500_000), "12.5M")
})
