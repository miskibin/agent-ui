import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import {
  captureCheckpoint,
  checkpointRefFor,
  checkpointRefsRoot,
  deleteCheckpointRefs,
  diffCheckpoints,
  hasCheckpointRef,
  isGitWorktree,
  restoreCheckpoint,
} from "@/lib/checkpoints"

/**
 * The undo behind a turn: capture, diff, restore.
 *
 * Everything here runs against a real checkout, because every claim worth
 * making is a claim about what git actually did — that the capture wrote a
 * commit reachable from nothing, that it did **not** touch the index the user
 * had staged, and that a restore puts back files the agent changed *and*
 * removes files it created.
 */

let repo = ""
const SESSION = "s-checkpoint-test"

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" })
const read = (name: string) => readFileSync(join(repo, name), "utf8")
const write = (name: string, text: string) =>
  writeFileSync(join(repo, name), text)

before(() => {
  repo = mkdtempSync(join(tmpdir(), "checkpoints-"))
  git("init", "-q", "-b", "main", ".")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  write("a.txt", "one\n")
  write("keep.txt", "keep\n")
  git("add", "-A")
  git("commit", "-qm", "first")
})

after(() => rmSync(repo, { recursive: true, force: true }))

test("a ref is built from the session id, not interpolated from it", () => {
  const ref = checkpointRefFor("chat/one two", 3)
  assert.equal(ref.startsWith("refs/agent-ui/checkpoints/"), true)
  assert.equal(ref.endsWith("/turn/3"), true)
  // A ref name may hold none of those characters; base64url holds none of them.
  assert.match(ref, /^[A-Za-z0-9/_-]+$/)
  assert.equal(checkpointRefFor("chat", 1).startsWith(checkpointRefsRoot("chat")), true)
})

test("a checkout is recognized as one", async () => {
  assert.equal(await isGitWorktree(repo), true)
  const plain = mkdtempSync(join(tmpdir(), "checkpoints-plain-"))
  try {
    assert.equal(await isGitWorktree(plain), false)
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

test("a capture commits the worktree without disturbing what the user staged", async () => {
  // The user has staged one file and left another edited but unstaged. This is
  // the state a capture after every turn must be invisible to.
  write("keep.txt", "staged edit\n")
  git("add", "keep.txt")
  write("a.txt", "one\ntwo\n")
  const stagedBefore = git("diff", "--cached", "--name-only")

  const ref = checkpointRefFor(SESSION, 0)
  const captured = await captureCheckpoint(repo, ref)
  assert.equal(captured.ok, true, JSON.stringify(captured))
  assert.equal(await hasCheckpointRef(repo, ref), true)

  assert.equal(git("diff", "--cached", "--name-only"), stagedBefore)
  // The commit is parentless and under a private namespace, so it is in no
  // branch's history and `git log` never mentions it.
  assert.equal(git("log", "--oneline").split("\n").filter(Boolean).length, 1)
  assert.equal(git("rev-list", "--count", ref).trim(), "1")
  // The scratch index is gone: it lives in .git and is nobody's business.
  assert.equal(
    readdirSync(join(repo, ".git")).some((entry) =>
      entry.startsWith("agent-ui-checkpoint-index-")
    ),
    false
  )
})

test("a capture includes untracked files, which is what makes them undoable", async () => {
  write("generated.txt", "from a script\n")
  const ref = checkpointRefFor(SESSION, 1)
  assert.equal((await captureCheckpoint(repo, ref)).ok, true)
  const listed = git("ls-tree", "-r", "--name-only", ref)
  assert.equal(listed.includes("generated.txt"), true)
})

test("the diff between two checkpoints is what the turn really changed", async () => {
  const diffed = await diffCheckpoints(
    repo,
    checkpointRefFor(SESSION, 0),
    checkpointRefFor(SESSION, 1)
  )
  assert.equal(diffed.ok, true)
  if (!diffed.ok) return
  assert.deepEqual(diffed.files, [
    { path: "generated.txt", insertions: 1, deletions: 0 },
  ])
})

test("a diff against a checkpoint that was never taken is an error, not an empty list", async () => {
  const diffed = await diffCheckpoints(
    repo,
    checkpointRefFor(SESSION, 0),
    checkpointRefFor(SESSION, 99)
  )
  assert.equal(diffed.ok, false)
})

test("a restore puts changed files back and removes created ones", async () => {
  // What a turn does: edit a tracked file, create two new ones.
  write("a.txt", "one\ntwo\nthree\nfour\n")
  write("more.txt", "new\n")
  mkdirSync(join(repo, "nested"), { recursive: true })
  write("nested/deep.txt", "new\n")

  const restored = await restoreCheckpoint(repo, checkpointRefFor(SESSION, 0))
  assert.equal(restored.ok, true, JSON.stringify(restored))

  assert.equal(read("a.txt"), "one\ntwo\n")
  assert.equal(existsSync(join(repo, "more.txt")), false)
  assert.equal(existsSync(join(repo, "nested")), false)
  // `generated.txt` was created after checkpoint 0, so it goes too.
  assert.equal(existsSync(join(repo, "generated.txt")), false)
  // The restore had to stage the whole tree to get there; `reset` puts the
  // index back to HEAD, so the user is not left staring at a staged tree they
  // never made. What was *staged* before the rewind does not survive it — a
  // restore rewinds the folder, and the file's contents are what comes back:
  // keep.txt still reads as it did at the checkpoint, just unstaged.
  assert.equal(git("diff", "--cached", "--name-only").trim(), "")
  assert.equal(read("keep.txt"), "staged edit\n")
  // Both files the checkpoint held differ from HEAD, exactly as they did when
  // it was taken — the rewind restores the worktree, not the staging area.
  assert.deepEqual(git("diff", "--name-only").trim().split("\n").sort(), [
    "a.txt",
    "keep.txt",
  ])
})

test("restoring a checkpoint that is gone fails rather than doing something", async () => {
  const restored = await restoreCheckpoint(repo, checkpointRefFor(SESSION, 99))
  assert.equal(restored.ok, false)
})

test("deleting a chat's refs leaves the repository as it was", async () => {
  assert.equal(await deleteCheckpointRefs(repo, SESSION), 2)
  assert.equal(await hasCheckpointRef(repo, checkpointRefFor(SESSION, 0)), false)
  assert.equal(await hasCheckpointRef(repo, checkpointRefFor(SESSION, 1)), false)
  // Idempotent: a chat deleted twice, or one whose folder never had any.
  assert.equal(await deleteCheckpointRefs(repo, SESSION), 0)
})

test("a repository with no commits can still be checkpointed", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "checkpoints-unborn-"))
  try {
    execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: fresh })
    writeFileSync(join(fresh, "only.txt"), "x\n")
    const ref = checkpointRefFor("unborn", 0)
    const captured = await captureCheckpoint(fresh, ref)
    assert.equal(captured.ok, true, JSON.stringify(captured))
    assert.equal(await hasCheckpointRef(fresh, ref), true)
  } finally {
    rmSync(fresh, { recursive: true, force: true })
  }
})
