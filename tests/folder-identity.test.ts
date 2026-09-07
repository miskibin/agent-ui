import assert from "node:assert/strict"
import { test } from "node:test"

import type { ChatSidebarItemData } from "@/components/ui/chat-sidebar"
import {
  normalizeFolder,
  normalizeFolderForComparison,
  sameFolder,
} from "@/lib/folder-identity"
import { sameWorkingFolder } from "@/lib/handoff/types"
import { groupIdForSession, groupSessions } from "@/lib/session-groups"
import type { SessionMeta } from "@/lib/store/types"

/**
 * One folder, spelled several ways. A Windows path that differs only in its
 * separators or its drive-letter case must resume the same backend session and
 * land in the same sidebar section; a POSIX path must keep its case, because
 * `/tmp/A` and `/tmp/a` are two folders.
 */

test("trailing separators go, roots keep theirs, and a bare drive is not a root", () => {
  assert.equal(normalizeFolder("/home/user/repo/"), "/home/user/repo")
  assert.equal(normalizeFolder("C:\\repo\\\\"), "C:\\repo")
  assert.equal(normalizeFolder("/"), "/")
  assert.equal(normalizeFolder("C:\\"), "C:\\")
  assert.equal(normalizeFolder("C:/"), "C:/")
  // "C:" means "the current directory on C:", so it is completed, not kept.
  assert.equal(normalizeFolder("C:"), "C:\\")
  assert.equal(normalizeFolder("  "), "")
})

test("Windows spellings fold together; POSIX ones do not", () => {
  const key = normalizeFolderForComparison("C:\\repo")
  assert.equal(normalizeFolderForComparison("C:\\repo\\"), key)
  assert.equal(normalizeFolderForComparison("c:/repo"), key)
  assert.equal(normalizeFolderForComparison("C:/repo/"), key)
  assert.equal(normalizeFolderForComparison("\\\\server\\Share\\Repo"), "\\\\server\\share\\repo")
  assert.notEqual(
    normalizeFolderForComparison("/tmp/A"),
    normalizeFolderForComparison("/tmp/a")
  )
})

test("two empties are the same folder, and a handoff agrees", () => {
  assert.equal(sameFolder(undefined, ""), true)
  assert.equal(sameWorkingFolder(undefined, "  "), true)
  assert.equal(sameWorkingFolder("C:\\repo", "c:/repo/"), true)
  assert.equal(sameWorkingFolder("/a", "/b"), false)
})

function meta(id: string, cwd: string): SessionMeta {
  return {
    id,
    title: id,
    pinned: false,
    order: 0,
    providerId: "mock",
    model: "",
    cwd,
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
  }
}

function item(id: string): ChatSidebarItemData {
  return { id, title: id }
}

test("one Windows folder spelled two ways is one sidebar section", () => {
  const sessions = [meta("a", "C:\\repo"), meta("b", "c:/repo/")]
  const groups = groupSessions(sessions, sessions.map((session) => item(session.id)))
  assert.equal(groups.folders.length, 1)
  assert.equal(groups.folders[0].items.length, 2)
  // The header still says what the user typed, not our comparison key.
  assert.equal(groups.folders[0].cwd, "C:\\repo")
  assert.equal(groups.folders[0].label, "repo")
  // And the id a chat is looked up under is the same for both spellings.
  assert.equal(groupIdForSession(sessions[0]), groupIdForSession(sessions[1]))
  assert.equal(groupIdForSession(sessions[0]), groups.folders[0].id)
})
