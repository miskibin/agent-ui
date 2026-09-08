import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import { changedFiles } from "@/lib/git-diff"

/**
 * What the review panel is drawn from. The cases worth pinning are the ones a
 * chat's folder is actually in: a file the agent just *created* (untracked, and
 * therefore absent from a plain `git diff`), a repository with no commit to
 * diff against yet, and a new directory — which `git status` collapses to one
 * entry that is not a file and has no patch behind it.
 */

const roots: string[] = []

function repo(withCommit = true) {
  const root = mkdtempSync(join(tmpdir(), "agent-ui-diff-"))
  roots.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" })
  git("init", "-b", "main")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  if (withCommit) {
    writeFileSync(join(root, "kept.txt"), "one\ntwo\nthree\n")
    git("add", "-A")
    git("commit", "-m", "init")
  }
  return { root, git }
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test("a modified file comes back with its own patch", async () => {
  const { root } = repo()
  writeFileSync(join(root, "kept.txt"), "one\ntwo CHANGED\nthree\n")
  const [file, ...rest] = await changedFiles(root)
  assert.equal(rest.length, 0)
  assert.equal(file.path, "kept.txt")
  assert.equal(file.status, "M")
  assert.ok(file.patch.includes("+two CHANGED"))
  assert.ok(file.patch.includes("-two"))
})

test("a file the agent created is not missing just because it is untracked", async () => {
  const { root } = repo()
  writeFileSync(join(root, "new.ts"), "export const x = 1\n")
  const files = await changedFiles(root)
  const created = files.find((file) => file.path === "new.ts")
  assert.equal(created?.status, "A")
  assert.ok(created?.patch.includes("+export const x = 1"))
})

test("a new directory is expanded, not shown as a folder with no diff", async () => {
  const { root } = repo()
  mkdirSync(join(root, "sub", "deep"), { recursive: true })
  writeFileSync(join(root, "sub", "deep", "a.ts"), "export const a = 1\n")
  const files = await changedFiles(root)
  assert.deepEqual(
    files.map((file) => file.path),
    ["sub/deep/a.ts"],
    "the files inside it, never the directory"
  )
  assert.ok(files[0].patch.length > 0)
})

test("a repository with no commit yet has no HEAD to diff against, and still answers", async () => {
  const { root } = repo(false)
  writeFileSync(join(root, "first.md"), "# hello\n")
  const files = await changedFiles(root)
  assert.deepEqual(
    files.map((file) => file.path),
    ["first.md"]
  )
  assert.equal(files[0].status, "A")
})

test("a deleted file is reported, with the side that went", async () => {
  const { root } = repo()
  rmSync(join(root, "kept.txt"))
  const [file] = await changedFiles(root)
  assert.equal(file.path, "kept.txt")
  assert.equal(file.status, "D")
  assert.ok(file.patch.includes("-one"))
})

test("a clean worktree is empty rather than an error", async () => {
  const { root } = repo()
  assert.deepEqual(await changedFiles(root), [])
})

test("a folder that is not a repository answers with nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-ui-nogit-"))
  roots.push(root)
  writeFileSync(join(root, "a.txt"), "hi\n")
  assert.deepEqual(await changedFiles(root), [])
})
