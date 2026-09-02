import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { readDiffStat, readWorktreeSnapshot } from "@/lib/handoff/snapshot"

/**
 * The snapshot half talks to a real `git`, so this exercises a real
 * repository — including the promise that matters most: reading it never
 * changes what the user has staged.
 */

let repo = ""
const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })

before(() => {
  repo = mkdtempSync(join(tmpdir(), "handoff-git-"))
  git(["init", "-q", "-b", "main"])
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n")
  writeFileSync(join(repo, "kept.txt"), "one\n")
  writeFileSync(join(repo, "gone.txt"), "two\n")
  git(["add", "-A"])
  git(["commit", "-qm", "first"])
})

after(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
})

test("a clean repo snapshots its head and nothing else", async () => {
  const snapshot = await readWorktreeSnapshot(repo)
  assert.ok(snapshot)
  assert.match(snapshot.head, /^[0-9a-f]{40}$/)
  assert.deepEqual(snapshot.status, [])
})

test("staged, unstaged, deleted and untracked all show; ignored does not", async () => {
  writeFileSync(join(repo, "staged.txt"), "s\n")
  git(["add", "staged.txt"])
  writeFileSync(join(repo, "kept.txt"), "one changed\n")
  rmSync(join(repo, "gone.txt"))
  writeFileSync(join(repo, "untracked.txt"), "u\n")
  writeFileSync(join(repo, "ignored.txt"), "i\n")

  const snapshot = await readWorktreeSnapshot(repo)
  assert.ok(snapshot)
  const status = snapshot.status.join("\n")
  assert.match(status, /^A {2}staged\.txt$/m)
  assert.match(status, /^ M kept\.txt$/m)
  assert.match(status, /^ D gone\.txt$/m)
  assert.match(status, /^\?\? untracked\.txt$/m)
  assert.equal(status.includes("ignored.txt"), false)
})

test("reading the snapshot leaves the real index untouched", async () => {
  const before = {
    status: git(["status", "--porcelain=v1", "--untracked-files=all"]),
    index: readFileSync(join(repo, ".git", "index")),
    staged: git(["diff", "--cached", "--name-only"]),
  }
  await readWorktreeSnapshot(repo)
  await readDiffStat(repo, git(["rev-parse", "HEAD"]).trim())
  const after = {
    status: git(["status", "--porcelain=v1", "--untracked-files=all"]),
    index: readFileSync(join(repo, ".git", "index")),
    staged: git(["diff", "--cached", "--name-only"]),
  }
  assert.equal(after.status, before.status)
  assert.equal(after.staged, before.staged)
  assert.ok(after.index.equals(before.index), "the git index file changed")
})

test("the diff spans commits and uncommitted work, without its summary line", async () => {
  const head = git(["rev-parse", "HEAD"]).trim()
  git(["add", "-A"])
  git(["commit", "-qm", "second"])
  writeFileSync(join(repo, "kept.txt"), "one changed again\n")

  const rows = await readDiffStat(repo, head)
  assert.ok(rows)
  const text = rows.join("\n")
  assert.match(text, /staged\.txt/)
  assert.match(text, /kept\.txt/)
  assert.equal(/files? changed/.test(text), false)
})

test("no folder, no repo and no head are all just 'unknown'", async () => {
  const plain = mkdtempSync(join(tmpdir(), "handoff-plain-"))
  try {
    assert.equal(await readWorktreeSnapshot(undefined), undefined)
    assert.equal(await readWorktreeSnapshot(""), undefined)
    assert.equal(await readWorktreeSnapshot(plain), undefined)
    assert.equal(await readWorktreeSnapshot(join(plain, "nope")), undefined)
    assert.equal(await readDiffStat(repo, undefined), null)
    assert.equal(await readDiffStat(repo, "not-a-sha"), null)
    // A well-formed id that is not in this repo fails the command, not the app.
    assert.equal(await readDiffStat(repo, "0".repeat(40)), null)
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})
