import assert from "node:assert/strict"
import { test } from "node:test"

import type { ChatSidebarItemData } from "@/components/ui/chat-sidebar"
import {
  NO_FOLDER_GROUP_ID,
  PINNED_GROUP_ID,
  SETTLED_SHELF_ID,
  SNOOZED_SHELF_ID,
  groupIdForSession,
  groupSessions,
  shelfOpenKey,
  sidebarListId,
} from "@/lib/session-groups"
import type { SessionMeta } from "@/lib/store/types"

/**
 * The sidebar's sections: pinned first, then one per working folder ordered by
 * activity, and the folderless leftovers last.
 */

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
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

function item(id: string, extra: Partial<ChatSidebarItemData> = {}): ChatSidebarItemData {
  return { id, title: id, ...extra }
}

function view(sessions: SessionMeta[]) {
  return groupSessions(
    sessions,
    sessions.map((session) => item(session.id))
  )
}

const HOUR = 60 * 60 * 1000
const NOW = 1_700_000_000_000

test("no sessions is no groups", () => {
  const groups = groupSessions([], [])
  assert.deepEqual(groups.pinned, [])
  assert.deepEqual(groups.folders, [])
  assert.equal(groups.snoozed.total, 0)
  assert.equal(groups.settled.total, 0)
})

test("pinned chats are their own flat group, whatever folder they name", () => {
  const groups = view([
    meta("a", { pinned: true, cwd: "/home/me/api" }),
    meta("b", { cwd: "/home/me/api" }),
  ])
  assert.deepEqual(
    groups.pinned.map((entry) => entry.id),
    ["a"]
  )
  assert.deepEqual(
    groups.folders.flatMap((group) => group.items.map((entry) => entry.id)),
    ["b"]
  )
  assert.equal(groupIdForSession({ pinned: true, cwd: "/home/me/api" }), PINNED_GROUP_ID)
})

test("the pinned group keeps the order it was handed", () => {
  const groups = view([
    meta("first", { pinned: true, updatedAt: 1 }),
    meta("second", { pinned: true, updatedAt: 9 }),
  ])
  assert.deepEqual(
    groups.pinned.map((entry) => entry.id),
    ["first", "second"]
  )
})

test("groups and their rows are ordered by updatedAt, newest first", () => {
  const groups = view([
    meta("old", { cwd: "/home/me/api", updatedAt: 10 }),
    meta("new", { cwd: "/home/me/api", updatedAt: 30 }),
    meta("other", { cwd: "/home/me/web", updatedAt: 20 }),
  ])
  assert.deepEqual(
    groups.folders.map((group) => group.label),
    ["api", "web"]
  )
  assert.deepEqual(
    groups.folders[0].items.map((entry) => entry.id),
    ["new", "old"]
  )
  assert.equal(groups.folders[0].updatedAt, 30)
})

test("chats with no folder come last, in their own group", () => {
  const groups = view([
    meta("loose", { updatedAt: 99 }),
    meta("filed", { cwd: "/home/me/api", updatedAt: 1 }),
  ])
  assert.deepEqual(
    groups.folders.map((group) => group.id),
    [`folder:/home/me/api`, NO_FOLDER_GROUP_ID]
  )
  assert.equal(groups.folders[1].label, "No folder")
  assert.equal(groupIdForSession({ pinned: false, cwd: "  " }), NO_FOLDER_GROUP_ID)
})

test("two spellings of one folder are one group", () => {
  const groups = view([
    meta("a", { cwd: "/home/me/api" }),
    meta("b", { cwd: "/home/me/api/" }),
  ])
  assert.equal(groups.folders.length, 1)
  assert.equal(groups.folders[0].items.length, 2)
})

test("two checkouts sharing a basename grow a parent segment", () => {
  const groups = view([
    meta("a", { cwd: "/home/me/work/api", updatedAt: 2 }),
    meta("b", { cwd: "/home/me/oss/api", updatedAt: 1 }),
    meta("c", { cwd: "/home/me/web", updatedAt: 3 }),
  ])
  assert.deepEqual(
    groups.folders.map((group) => group.label),
    ["web", "work/api", "oss/api"]
  )
})

test("a Windows folder is widened with a Windows separator", () => {
  const groups = view([
    meta("a", { cwd: "D:\\work\\api" }),
    meta("b", { cwd: "D:\\oss\\api" }),
  ])
  assert.deepEqual(
    groups.folders.map((group) => group.label).sort(),
    ["oss\\api", "work\\api"]
  )
})

test("a header carries the newest chat's branch and any live run", () => {
  const sessions = [
    meta("old", { cwd: "/home/me/api", updatedAt: 1, gitBranch: "main" }),
    meta("new", { cwd: "/home/me/api", updatedAt: 5, gitBranch: "feature" }),
  ]
  const groups = groupSessions(sessions, [
    item("old", { status: "streaming" }),
    item("new"),
  ])
  assert.equal(groups.folders[0].branch, "feature")
  assert.equal(groups.folders[0].running, true)
})

test("a session with no rendered row is skipped rather than guessed at", () => {
  const groups = groupSessions([meta("a", { cwd: "/home/me/api" })], [])
  assert.deepEqual(groups.folders, [])
})

/* -------------------------------------------------------------------------- */
/* The shelves                                                                 */
/* -------------------------------------------------------------------------- */

function shelved(sessions: SessionMeta[], options = {}) {
  return groupSessions(
    sessions,
    sessions.map((session) => item(session.id)),
    { now: NOW, ...options }
  )
}

test("a snoozed chat leaves its folder for the Snoozed shelf", () => {
  const groups = shelved([
    meta("awake", { cwd: "/home/me/api" }),
    meta("down", { cwd: "/home/me/api", snoozedUntil: NOW + HOUR }),
  ])
  assert.deepEqual(
    groups.folders.flatMap((group) => group.items.map((entry) => entry.id)),
    ["awake"]
  )
  assert.equal(groups.snoozed.total, 1)
  assert.equal(
    sidebarListId(meta("down", { snoozedUntil: NOW + HOUR }), NOW),
    SNOOZED_SHELF_ID
  )
})

test("a snooze that has run out is back in its folder, not on the shelf", () => {
  const groups = shelved([
    meta("woke", { cwd: "/home/me/api", snoozedUntil: NOW - HOUR }),
  ])
  assert.equal(groups.snoozed.total, 0)
  assert.equal(groups.folders[0].items.length, 1)
})

test("a settled chat goes to the Settled shelf, newest settle first", () => {
  const groups = shelved([
    meta("older", { cwd: "/home/me/api", settledAt: NOW - 5 * HOUR }),
    meta("newer", { cwd: "/home/me/api", settledAt: NOW - HOUR }),
  ])
  assert.deepEqual(groups.folders, [])
  assert.deepEqual(
    // Closed by default, so nothing renders — the count is still the truth.
    [groups.settled.total, groups.settled.items.length],
    [2, 0]
  )
  const open = shelved(
    [
      meta("older", { cwd: "/home/me/api", settledAt: NOW - 5 * HOUR }),
      meta("newer", { cwd: "/home/me/api", settledAt: NOW - HOUR }),
    ],
    { settledOpen: true }
  )
  assert.deepEqual(
    open.settled.items.map((entry) => entry.id),
    ["newer", "older"]
  )
})

test("the Snoozed shelf is ordered by what comes back next", () => {
  const groups = shelved(
    [
      meta("late", { snoozedUntil: NOW + 5 * HOUR }),
      meta("soon", { snoozedUntil: NOW + HOUR }),
    ],
    { snoozedOpen: true }
  )
  assert.deepEqual(
    groups.snoozed.items.map((entry) => entry.id),
    ["soon", "late"]
  )
})

test("an override outranks the timestamp in both directions", () => {
  const groups = shelved(
    [
      meta("kept", { settledAt: NOW - HOUR, settledOverride: "active" }),
      meta("filed", { settledOverride: "settled" }),
    ],
    { settledOpen: true }
  )
  assert.deepEqual(
    groups.settled.items.map((entry) => entry.id),
    ["filed"]
  )
  assert.deepEqual(
    groups.folders.flatMap((group) => group.items.map((entry) => entry.id)),
    ["kept"]
  )
})

test("a snooze outranks settled, and a pin outranks neither", () => {
  const groups = shelved(
    [
      meta("both", {
        pinned: true,
        settledOverride: "settled",
        snoozedUntil: NOW + HOUR,
      }),
      meta("pinned-settled", { pinned: true, settledOverride: "settled" }),
    ],
    { snoozedOpen: true, settledOpen: true }
  )
  assert.deepEqual(
    groups.snoozed.items.map((entry) => entry.id),
    ["both"]
  )
  assert.deepEqual(
    groups.settled.items.map((entry) => entry.id),
    ["pinned-settled"]
  )
  assert.deepEqual(groups.pinned, [])
})

test("an open shelf shows ten rows and counts the rest", () => {
  const sessions = Array.from({ length: 14 }, (_, index) =>
    meta(`s${index}`, { settledAt: NOW - index * HOUR })
  )
  const first = shelved(sessions, { settledOpen: true })
  assert.equal(first.settled.items.length, 10)
  assert.equal(first.settled.hidden, 4)
  const paged = shelved(sessions, { settledOpen: true, settledVisible: 35 })
  assert.equal(paged.settled.items.length, 14)
  assert.equal(paged.settled.hidden, 0)
})

test("the open chat is pulled in past the page and out of a closed shelf", () => {
  const sessions = Array.from({ length: 14 }, (_, index) =>
    meta(`s${index}`, { settledAt: NOW - index * HOUR })
  )
  const deep = shelved(sessions, {
    settledOpen: true,
    keepVisible: ["s13"],
  })
  assert.equal(deep.settled.items.length, 11)
  assert.equal(deep.settled.items.at(-1)?.id, "s13")
  assert.equal(deep.settled.hidden, 3)

  const closed = shelved(sessions, { keepVisible: ["s13"] })
  assert.deepEqual(
    closed.settled.items.map((entry) => entry.id),
    ["s13"]
  )
})

test("a shelf remembers its fold under a key of its own", () => {
  assert.equal(shelfOpenKey(SNOOZED_SHELF_ID), "shelf:snoozed:open")
  assert.equal(shelfOpenKey(SETTLED_SHELF_ID), "shelf:settled:open")
})

/* -------------------------------------------------------------------------- */
/* Worktree headers                                                            */
/* -------------------------------------------------------------------------- */

test("a worktree group is headed by its repository and its own branch", () => {
  const groups = view([
    meta("wt", {
      cwd: "/data/worktrees/agent-ui/feature-x",
      gitBranch: "ignored",
      worktree: {
        root: "/data/worktrees/agent-ui/feature-x",
        branch: "feature-x",
        repoRoot: "/home/me/code/agent-ui",
      },
    }),
  ])
  assert.equal(groups.folders[0].label, "agent-ui")
  assert.equal(groups.folders[0].branch, "feature-x")
  assert.equal(groups.folders[0].worktree, true)
  // The section is still keyed by the folder the chat actually runs in.
  assert.equal(groups.folders[0].cwd, "/data/worktrees/agent-ui/feature-x")
})

test("two worktrees of same-named repositories widen along the repository", () => {
  const groups = view([
    meta("a", {
      cwd: "/data/worktrees/api-1",
      updatedAt: 2,
      worktree: {
        root: "/data/worktrees/api-1",
        branch: "one",
        repoRoot: "/home/me/work/api",
      },
    }),
    meta("b", {
      cwd: "/data/worktrees/api-2",
      updatedAt: 1,
      worktree: {
        root: "/data/worktrees/api-2",
        branch: "two",
        repoRoot: "/home/me/oss/api",
      },
    }),
  ])
  assert.deepEqual(
    groups.folders.map((group) => group.label),
    ["work/api", "oss/api"]
  )
})

test("a folder falls back to today's behaviour without a worktree", () => {
  const groups = view([meta("a", { cwd: "/home/me/api", gitBranch: "main" })])
  assert.equal(groups.folders[0].label, "api")
  assert.equal(groups.folders[0].branch, "main")
  assert.equal(groups.folders[0].worktree, false)
})
