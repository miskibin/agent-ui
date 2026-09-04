import assert from "node:assert/strict"
import { test } from "node:test"

import {
  migrateAgentSessions,
  nextAgentSessionState,
  resolveResumeSessionId,
} from "@/lib/handoff/cursor"
import {
  providerSessionHints,
  snapshotsDiffer,
  type AgentSessionState,
} from "@/lib/handoff/types"

const entry: AgentSessionState = {
  providerSessionId: "backend-1",
  cwd: "/repo",
  lastSeenSeq: 4,
  lastWroteSeq: 4,
  lastActiveAt: 100,
}

test("a stored session resumes in the folder it was minted in", () => {
  assert.equal(resolveResumeSessionId(entry, "/repo", true), "backend-1")
})

test("a different folder means a fresh backend session", () => {
  assert.equal(resolveResumeSessionId(entry, "/other", true), undefined)
})

test("a provider that cannot resume never gets an id", () => {
  assert.equal(resolveResumeSessionId(entry, "/repo", false), undefined)
})

test("no entry, no resume", () => {
  assert.equal(resolveResumeSessionId(undefined, "/repo", true), undefined)
})

test("a started run advances the cursor past what it was handed", () => {
  const next = nextAgentSessionState({
    previous: entry,
    journalEnd: 9,
    wrote: true,
    runStarted: true,
    cwd: "/repo",
    now: 200,
  })
  assert.equal(next.lastSeenSeq, 9)
  assert.equal(next.lastWroteSeq, 9)
  assert.equal(next.lastActiveAt, 200)
  // The id survives a turn that reported no new one.
  assert.equal(next.providerSessionId, "backend-1")
})

test("a run that never started leaves the handoff cursor where it was", () => {
  const next = nextAgentSessionState({
    previous: entry,
    journalEnd: 9,
    wrote: true,
    runStarted: false,
    cwd: "/repo",
    now: 200,
  })
  assert.equal(next.lastSeenSeq, 4)
  assert.equal(next.lastWroteSeq, 9)
})

test("an aborted turn still counts as seen once the backend spoke", () => {
  const next = nextAgentSessionState({
    previous: entry,
    journalEnd: 11,
    wrote: true,
    runStarted: true,
    now: 200,
  })
  assert.equal(next.lastSeenSeq, 11)
})

test("a new backend id replaces the old one; the snapshot falls back", () => {
  const snapshot = { head: "aaa", status: [] }
  const next = nextAgentSessionState({
    previous: { ...entry, snapshot },
    journalEnd: 5,
    wrote: true,
    runStarted: true,
    cwd: "/repo",
    providerSessionId: "backend-2",
    now: 200,
  })
  assert.equal(next.providerSessionId, "backend-2")
  assert.deepEqual(next.snapshot, snapshot)
})

test("a repointed chat inherits neither the id nor the worktree it was taken in", () => {
  const next = nextAgentSessionState({
    previous: { ...entry, snapshot: { head: "aaa", status: [] } },
    journalEnd: 5,
    wrote: true,
    // The turn never reached the backend, so it minted no id of its own.
    runStarted: false,
    cwd: "/other",
    now: 200,
  })
  assert.equal(next.providerSessionId, undefined)
  assert.equal(next.snapshot, undefined)
  assert.equal(next.cwd, "/other")
})

test("a first turn starts both cursors from nothing", () => {
  const next = nextAgentSessionState({
    journalEnd: 3,
    wrote: true,
    runStarted: true,
    now: 1,
  })
  assert.deepEqual(next, {
    lastSeenSeq: 3,
    lastWroteSeq: 3,
    lastActiveAt: 1,
  })
})

test("a legacy index migrates its single id to the provider that ran", () => {
  const migrated = migrateAgentSessions(undefined, {
    providerId: "cursor",
    providerSessionId: "legacy-1",
    cwd: "/repo",
    updatedAt: 42,
  })
  assert.deepEqual(migrated, {
    cursor: {
      providerSessionId: "legacy-1",
      cwd: "/repo",
      lastSeenSeq: 0,
      lastWroteSeq: 0,
      lastActiveAt: 42,
    },
  })
})

test("a legacy index with no stored id migrates to nothing", () => {
  assert.equal(
    migrateAgentSessions(undefined, {
      providerId: "cursor",
      providerSessionId: "",
      updatedAt: 42,
    }),
    undefined
  )
})

test("an existing map wins over the legacy field and is field-checked", () => {
  const migrated = migrateAgentSessions(
    {
      pi: { providerSessionId: "pi-1", cwd: "/repo", lastSeenSeq: 3, lastWroteSeq: 5, lastActiveAt: 9 },
      broken: "nope",
      partial: { lastSeenSeq: "x", snapshot: { head: "h", status: ["a", 2] } },
    },
    { providerId: "cursor", providerSessionId: "legacy-1", updatedAt: 42 }
  )
  assert.deepEqual(migrated?.pi, {
    providerSessionId: "pi-1",
    cwd: "/repo",
    lastSeenSeq: 3,
    lastWroteSeq: 5,
    lastActiveAt: 9,
  })
  assert.equal(migrated?.cursor, undefined)
  assert.equal(migrated?.broken, undefined)
  assert.deepEqual(migrated?.partial, {
    lastSeenSeq: 0,
    lastWroteSeq: 0,
    lastActiveAt: 0,
    snapshot: { head: "h", status: ["a"] },
  })
})

test("snapshots differ on head, on membership, and not on order", () => {
  assert.equal(
    snapshotsDiffer({ head: "a", status: [] }, { head: "b", status: [] }),
    true
  )
  assert.equal(
    snapshotsDiffer(
      { head: "a", status: [" M x"] },
      { head: "a", status: [" M x", "?? y"] }
    ),
    true
  )
  assert.equal(
    snapshotsDiffer(
      { head: "a", status: [" M x", "?? y"] },
      { head: "a", status: ["?? y", " M x"] }
    ),
    false
  )
  assert.equal(
    snapshotsDiffer(
      { head: "a", status: [" M x"] },
      { head: "a", status: ["M  x"] }
    ),
    true
  )
})

test("composer hints: who resumes, who last ran, who owes a handoff", () => {
  const hints = providerSessionHints(
    {
      pi: { providerSessionId: "p", cwd: "/repo", lastSeenSeq: 2, lastWroteSeq: 2, lastActiveAt: 10 },
      cursor: { providerSessionId: "c", cwd: "/other", lastSeenSeq: 6, lastWroteSeq: 6, lastActiveAt: 20 },
      mock: { lastSeenSeq: 6, lastWroteSeq: 0, lastActiveAt: 5 },
    },
    "/repo"
  )
  assert.equal(hints.pi.resumes, true)
  // Same id, wrong folder: it will start a fresh backend session.
  assert.equal(hints.cursor.resumes, false)
  assert.equal(hints.mock.resumes, false)
  assert.equal(hints.pi.handoffPending, true)
  assert.equal(hints.cursor.handoffPending, false)
  assert.equal(hints.mock.handoffPending, false)
  assert.equal(hints.cursor.lastActiveAt, 20)
})

test("no per-agent state, no hints", () => {
  assert.deepEqual(providerSessionHints(undefined, "/repo"), {})
})
