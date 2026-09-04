import assert from "node:assert/strict"
import { test } from "node:test"

import { buildHandoff, STALE_WORKTREE_WARNING } from "@/lib/handoff/build"
import type { JournalEvent } from "@/lib/handoff/types"

let seq = 0
function reset() {
  seq = 0
}
function user(providerId: string, text: string): JournalEvent {
  return { seq: ++seq, at: seq, providerId, kind: "user-message", text }
}
function shell(
  providerId: string,
  command: string,
  extra: { status?: "done" | "error"; exitCode?: number } = {}
): JournalEvent {
  return {
    seq: ++seq,
    at: seq,
    providerId,
    kind: "tool",
    name: "bash",
    status: extra.status ?? "done",
    command,
    ...(extra.exitCode === undefined ? null : { exitCode: extra.exitCode }),
  }
}
function edit(providerId: string, path: string): JournalEvent {
  return {
    seq: ++seq,
    at: seq,
    providerId,
    kind: "tool",
    name: "Edit file",
    status: "done",
    paths: [path],
  }
}
function turnEnd(
  providerId: string,
  outcome: "ok" | "error" | "aborted",
  error?: string
): JournalEvent {
  return {
    seq: ++seq,
    at: seq,
    providerId,
    kind: "turn-end",
    model: "m",
    outcome,
    ...(error ? { error } : null),
  }
}

test("nothing to hand off returns undefined", () => {
  reset()
  assert.equal(
    buildHandoff({ events: [], lastSeenSeq: 0, providerId: "pi" }),
    undefined
  )
})

test("an agent is never handed back its own events", () => {
  reset()
  const events = [user("pi", "do it"), edit("pi", "lib/a.ts"), turnEnd("pi", "ok")]
  assert.equal(
    buildHandoff({ events, lastSeenSeq: 0, providerId: "pi" }),
    undefined
  )
})

test("only events past the cursor are handed over", () => {
  reset()
  const events = [
    edit("cursor", "old.ts"),
    edit("cursor", "new.ts"),
    turnEnd("cursor", "ok"),
  ]
  const result = buildHandoff({ events, lastSeenSeq: 1, providerId: "pi" })
  assert.ok(result)
  assert.ok(result.text.includes("new.ts"))
  assert.equal(result.text.includes("old.ts"), false)
  assert.equal(result.throughSeq, 3)
})

test("the block names requests, files, commands, tests and errors", () => {
  reset()
  const events = [
    user("cursor", "run the suite"),
    edit("cursor", "lib/a.ts"),
    shell("cursor", "npm test", { status: "error", exitCode: 1 }),
    shell("cursor", "git status"),
    turnEnd("cursor", "error", "cursor-agent exited with code 1"),
  ]
  const result = buildHandoff({ events, lastSeenSeq: 0, providerId: "pi" })
  assert.ok(result)
  assert.match(result.text, /Requests since then:/)
  assert.match(result.text, /“run the suite”/)
  assert.match(result.text, /Files changed:\n- lib\/a\.ts/)
  assert.match(result.text, /Commands run:/)
  assert.match(result.text, /npm test — exit 1 \(failed\)/)
  assert.match(result.text, /Test results:\n- npm test — exit 1 \(failed\)/)
  assert.match(result.text, /Errors and unfinished operations:/)
  assert.match(result.text, /cursor-agent exited with code 1/)
  assert.equal(result.marker.files, 1)
  assert.equal(result.marker.commands, 2)
  assert.equal(result.marker.errors, 2)
  assert.equal(result.marker.staleWorktree, false)
})

test("a stopped turn is reported as unfinished", () => {
  reset()
  const events = [user("cursor", "go"), turnEnd("cursor", "aborted")]
  const result = buildHandoff({ events, lastSeenSeq: 0, providerId: "pi" })
  assert.ok(result)
  assert.match(result.text, /stopped before it finished/)
})

test("a changed worktree always carries the warning, even with no delta", () => {
  reset()
  const result = buildHandoff({
    events: [],
    lastSeenSeq: 0,
    providerId: "pi",
    snapshot: { head: "aaa", status: [] },
    current: { head: "bbb", status: [] },
  })
  assert.ok(result)
  assert.ok(result.text.includes(STALE_WORKTREE_WARNING))
  assert.equal(result.marker.staleWorktree, true)
})

test("an unknown snapshot on either side says nothing about staleness", () => {
  reset()
  const events = [edit("cursor", "lib/a.ts"), turnEnd("cursor", "ok")]
  const result = buildHandoff({
    events,
    lastSeenSeq: 0,
    providerId: "pi",
    current: { head: "bbb", status: [" M lib/a.ts"] },
  })
  assert.ok(result)
  assert.equal(result.marker.staleWorktree, false)
  assert.equal(result.text.includes(STALE_WORKTREE_WARNING), false)
})

test("a reordered status set is not a change", () => {
  reset()
  const result = buildHandoff({
    events: [],
    lastSeenSeq: 0,
    providerId: "pi",
    snapshot: { head: "aaa", status: [" M a.ts", "?? b.ts"] },
    current: { head: "aaa", status: ["?? b.ts", " M a.ts"] },
  })
  assert.equal(result, undefined)
})

test("git rows fold in, and a file named twice is one row", () => {
  reset()
  const events = [edit("cursor", "/repo/lib/a.ts"), turnEnd("cursor", "ok")]
  const result = buildHandoff({
    events,
    lastSeenSeq: 0,
    providerId: "pi",
    diffStat: [" lib/a.ts | 4 ++--", " out/chart.png | Bin 0 -> 12 bytes"],
  })
  assert.ok(result)
  assert.equal(result.marker.files, 2)
  assert.match(result.text, /out\/chart\.png/)
  assert.equal(/a\.ts/g.test(result.text), true)
  assert.equal(result.text.match(/a\.ts/g)?.length, 1)
})

test("the dirty list stands in when there is no diff to take", () => {
  reset()
  const events = [turnEnd("cursor", "ok")]
  const result = buildHandoff({
    events,
    lastSeenSeq: 0,
    providerId: "pi",
    current: { head: "aaa", status: ["?? notes.md"] },
  })
  assert.ok(result)
  assert.match(result.text, /Files changed:\n- \?\? notes\.md/)
})

test("a huge dirty list is capped before the block ever reads it", () => {
  reset()
  const events = [edit("cursor", "/repo/lib/a.ts"), turnEnd("cursor", "ok")]
  const status = Array.from({ length: 5_000 }, (_, i) => `?? out/f${i}.png`)
  const build = (rows: string[]) =>
    buildHandoff({
      events,
      lastSeenSeq: 0,
      providerId: "pi",
      current: { head: "aaa", status: rows },
    })

  const all = build(status)
  assert.ok(all)
  // 40 rows printed — one tool path and the 39 status rows that fit beside it.
  assert.equal(all.marker.files, 40)
  assert.match(all.text, /out\/f38\.png/)
  assert.equal(all.text.includes("out/f39.png"), false)
  // Rows past the context cap cannot reach the renderer at all, so trimming
  // the input to it changes nothing.
  assert.equal(all.text, build(status.slice(0, 200))?.text)
})

test("shedding a long journal beside a dirty tree stays quick", () => {
  reset()
  const events = Array.from({ length: 400 }, (_, i) =>
    shell("cursor", `echo ${"x".repeat(60)} ${i}`)
  )
  const status = Array.from({ length: 20_000 }, (_, i) => `?? out/f${i}.png`)
  const started = Date.now()
  const result = buildHandoff({
    events,
    lastSeenSeq: 0,
    providerId: "pi",
    current: { head: "aaa", status },
  })
  assert.ok(result)
  assert.ok(result.text.length <= 8_000)
  // Every pass of the budget loop re-derives the file list, so a dirty tree
  // this size used to turn one handoff into minutes of string comparisons —
  // on the request thread, before the turn could start.
  assert.ok(
    Date.now() - started < 10_000,
    "budget shedding must not scale with the dirty list"
  )
})

test("only the newest three requests are quoted", () => {
  reset()
  const events = [
    user("cursor", "one"),
    user("cursor", "two"),
    user("cursor", "three"),
    user("cursor", "four"),
    turnEnd("cursor", "ok"),
  ]
  const result = buildHandoff({ events, lastSeenSeq: 0, providerId: "pi" })
  assert.ok(result)
  assert.equal(result.text.includes("“one”"), false)
  assert.match(result.text, /“four”/)
})

test("the budget holds, and the warning and newest errors survive it", () => {
  reset()
  const events: JournalEvent[] = []
  for (let index = 0; index < 400; index++) {
    events.push(shell("cursor", `echo ${"x".repeat(120)} ${index}`))
  }
  events.push(shell("cursor", "npm test", { status: "error", exitCode: 7 }))
  events.push(turnEnd("cursor", "error", "the last thing that went wrong"))

  const result = buildHandoff({
    events,
    lastSeenSeq: 0,
    providerId: "pi",
    snapshot: { head: "aaa", status: [] },
    current: { head: "bbb", status: [] },
    maxChars: 1_500,
  })
  assert.ok(result)
  assert.ok(result.text.length <= 1_500, `length ${result.text.length}`)
  assert.ok(result.text.includes(STALE_WORKTREE_WARNING))
  assert.match(result.text, /the last thing that went wrong/)
  assert.match(result.text, /npm test — exit 7 \(failed\)/)
  assert.equal(result.marker.chars, result.text.length)
  // The cursor still covers everything the delta held, truncated or not.
  assert.equal(result.throughSeq, events[events.length - 1].seq)
})

test("the same journal always builds the same block", () => {
  reset()
  const events = [
    user("cursor", "again"),
    edit("cursor", "lib/a.ts"),
    shell("cursor", "npm test", { status: "error" }),
    turnEnd("cursor", "error", "nope"),
  ]
  const input = { events, lastSeenSeq: 0, providerId: "pi" } as const
  assert.equal(buildHandoff(input)?.text, buildHandoff(input)?.text)
})
