import assert from "node:assert/strict"
import { test } from "node:test"

import {
  appendEvents,
  capJournal,
  looksLikeTestCommand,
  normalizeJournal,
  toolJournalEvent,
} from "@/lib/handoff/journal"
import type { JournalEvent } from "@/lib/handoff/types"

function tool(seq: number, providerId: string, extra: Record<string, unknown> = {}) {
  return {
    seq,
    at: seq,
    providerId,
    kind: "tool",
    name: "Shell",
    status: "done",
    ...extra,
  } as JournalEvent
}

test("appendEvents numbers new events after the last one", () => {
  const journal = appendEvents(
    [tool(7, "pi")],
    [
      { kind: "user-message", providerId: "cursor", text: "hi" },
      { kind: "turn-end", providerId: "cursor", model: "m", outcome: "ok" },
    ]
  )
  assert.deepEqual(
    journal.map((event) => event.seq),
    [7, 8, 9]
  )
})

test("the cap drops the oldest events and never renumbers the rest", () => {
  const existing = Array.from({ length: 5 }, (_, index) => tool(index + 1, "pi"))
  const journal = appendEvents(
    existing,
    [{ kind: "user-message", providerId: "cursor", text: "hi" }],
    3
  )
  assert.equal(journal.length, 3)
  assert.deepEqual(
    journal.map((event) => event.seq),
    [4, 5, 6]
  )
})

test("capJournal keeps everything under the cap", () => {
  const events = [tool(1, "pi"), tool(2, "pi")]
  assert.equal(capJournal(events, 10), events)
  assert.equal(capJournal(events, 1).length, 1)
})

test("a broken journal file degrades to the events that survive", () => {
  const journal = normalizeJournal([
    null,
    { seq: 2, providerId: "pi", kind: "tool", name: "Shell", status: "done" },
    { seq: 1, providerId: "pi", kind: "user-message", text: "first" },
    { seq: 3, providerId: "pi", kind: "tool", name: "Shell", status: "running" },
    { providerId: "pi", kind: "user-message", text: "no seq" },
    "nonsense",
  ])
  assert.deepEqual(
    journal.map((event) => event.seq),
    [1, 2]
  )
})

test("only terminal tool calls are journaled, and the plan pseudo-tool is not", () => {
  assert.equal(
    toolJournalEvent({ type: "tool", id: "a", name: "Shell", status: "running" }),
    null
  )
  assert.equal(
    toolJournalEvent({ type: "tool", id: "a", name: "plan", status: "done" }),
    null
  )
})

test("a shell call keeps its command, paths and published exit code", () => {
  assert.deepEqual(
    toolJournalEvent({
      type: "tool",
      id: "a",
      name: "bash",
      status: "error",
      input: JSON.stringify({ command: "npm test" }),
      exitCode: 1,
    }),
    { name: "bash", status: "error", command: "npm test", exitCode: 1 }
  )
  assert.deepEqual(
    toolJournalEvent({
      type: "tool",
      id: "b",
      name: "Edit file",
      status: "done",
      input: JSON.stringify({ target_file: "lib/a.ts" }),
    }),
    { name: "Edit file", status: "done", paths: ["lib/a.ts"] }
  )
})

test("an absent exit code is never invented", () => {
  const event = toolJournalEvent({
    type: "tool",
    id: "a",
    name: "bash",
    status: "done",
    input: JSON.stringify({ command: "ls" }),
  })
  assert.equal(Object.hasOwn(event ?? {}, "exitCode"), false)
})

test("test-run detection covers the usual runners and not ordinary commands", () => {
  for (const command of [
    "npm test",
    "npm run test -- --watch=false",
    "pnpm test",
    "npx vitest run",
    "pytest -q",
    "cargo test",
    "go test ./...",
    "python -m pytest",
    "make test",
  ]) {
    assert.equal(looksLikeTestCommand(command), true, command)
  }
  for (const command of ["npm run build", "git status", "ls tests"]) {
    assert.equal(looksLikeTestCommand(command), false, command)
  }
})
