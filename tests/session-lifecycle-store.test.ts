import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

/**
 * What the store keeps of a chat's lifecycle — and of the worktree it was
 * started in. Both are fields the sidebar cannot re-derive from anything else,
 * so a round trip through `index.json` is the only thing that proves they are
 * really persisted rather than merely typed.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), "agent-ui-lifecycle-"))
process.env.AGENT_UI_DIR = DATA_DIR

const { createSession, listSessions, patchSession } = await import(
  "@/lib/store/sessions"
)

const WORKTREE = {
  root: "/data/worktrees/agent-ui/feature-x",
  branch: "feature-x",
  baseBranch: "main",
  repoRoot: "/home/me/code/agent-ui",
}

async function reread(id: string) {
  return (await listSessions()).find((session) => session.id === id)
}

test("a chat created in a worktree remembers which repository it belongs to", async () => {
  const created = await createSession({
    title: "worktree chat",
    cwd: WORKTREE.root,
    worktree: WORKTREE,
  })
  assert.deepEqual(created.worktree, WORKTREE)
  assert.deepEqual((await reread(created.id))?.worktree, WORKTREE)
})

test("a worktree can be attached to a chat that already exists", async () => {
  const created = await createSession({ title: "plain" })
  assert.equal(created.worktree, undefined)
  const patched = await patchSession(created.id, { worktree: WORKTREE })
  assert.deepEqual(patched?.worktree, WORKTREE)
  assert.deepEqual((await reread(created.id))?.worktree, WORKTREE)
})

test("a half-written worktree is dropped rather than half-kept", async () => {
  const created = await createSession({
    title: "broken",
    // @ts-expect-error — exactly the shape a stale client could send.
    worktree: { root: "/data/worktrees/x" },
  })
  assert.equal(created.worktree, undefined)
})

test("the lifecycle fields survive a write and a re-read", async () => {
  const created = await createSession({ title: "lifecycle" })
  const now = Date.now()
  await patchSession(created.id, {
    settledAt: now,
    settledOverride: "settled",
    snoozedUntil: now + 3_600_000,
    snoozedAt: now,
    wokeAt: now - 10,
    lastVisitedAt: now - 20,
  })
  const stored = await reread(created.id)
  assert.deepEqual(
    {
      settledAt: stored?.settledAt,
      settledOverride: stored?.settledOverride,
      snoozedUntil: stored?.snoozedUntil,
      snoozedAt: stored?.snoozedAt,
      wokeAt: stored?.wokeAt,
      lastVisitedAt: stored?.lastVisitedAt,
    },
    {
      settledAt: now,
      settledOverride: "settled",
      snoozedUntil: now + 3_600_000,
      snoozedAt: now,
      wokeAt: now - 10,
      lastVisitedAt: now - 20,
    }
  )
})

test("zero clears a lifecycle timestamp, and \"\" clears the override", async () => {
  const created = await createSession({ title: "clearing" })
  const now = Date.now()
  await patchSession(created.id, {
    snoozedUntil: now + 1_000,
    snoozedAt: now,
    settledAt: now,
    settledOverride: "settled",
  })
  await patchSession(created.id, {
    snoozedUntil: 0,
    snoozedAt: 0,
    settledAt: 0,
    settledOverride: "",
  })
  const stored = await reread(created.id)
  assert.equal(stored?.snoozedUntil, undefined)
  assert.equal(stored?.snoozedAt, undefined)
  assert.equal(stored?.settledAt, undefined)
  assert.equal(stored?.settledOverride, undefined)
})

test("a nonsense override is refused rather than stored", async () => {
  const created = await createSession({ title: "nonsense" })
  await patchSession(created.id, {
    // @ts-expect-error — the vocabulary is closed on purpose.
    settledOverride: "sometimes",
  })
  assert.equal((await reread(created.id))?.settledOverride, undefined)
})

test("settling a chat is not activity: `updatedAt` stays where it was", async () => {
  const created = await createSession({ title: "quiet" })
  const before = created.updatedAt
  await new Promise((resolve) => setTimeout(resolve, 5))
  await patchSession(created.id, { settledAt: Date.now() })
  assert.equal((await reread(created.id))?.updatedAt, before)

  await patchSession(created.id, { lastVisitedAt: Date.now() })
  assert.equal((await reread(created.id))?.updatedAt, before)

  // A rename still is activity — the quiet rule is only about the lifecycle.
  await patchSession(created.id, { title: "renamed" })
  assert.notEqual((await reread(created.id))?.updatedAt, before)
})
