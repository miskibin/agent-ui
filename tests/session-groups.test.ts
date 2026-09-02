import assert from "node:assert/strict"
import { test } from "node:test"

import type { ChatSidebarItemData } from "@/components/ui/chat-sidebar"
import {
  NO_FOLDER_GROUP_ID,
  PINNED_GROUP_ID,
  groupIdForSession,
  groupSessions,
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

test("no sessions is no groups", () => {
  assert.deepEqual(groupSessions([], []), { pinned: [], folders: [] })
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
