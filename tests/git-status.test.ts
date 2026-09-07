import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import {
  gitStatus,
  invalidateGitStatus,
  parsePorcelainV2Z,
  prFailureTtl,
} from "@/lib/git-status"

/**
 * The sidebar's folder badge: what `git status --porcelain=2 -z` says, and how
 * a failed `gh` lookup backs off.
 */

test("the branch header, the ahead/behind pair and the upstream are read", () => {
  const status = parsePorcelainV2Z(
    "# branch.oid abc123\0" +
      "# branch.head feature/x\0" +
      "# branch.upstream origin/feature/x\0" +
      "# branch.ab +2 -1\0"
  )
  assert.equal(status.branch, "feature/x")
  assert.equal(status.upstream, "origin/feature/x")
  assert.equal(status.ahead, 2)
  assert.equal(status.behind, 1)
})

test("a detached head has no branch name", () => {
  const status = parsePorcelainV2Z("# branch.head (detached)\0")
  assert.equal(status.branch, "")
})

test("changed, renamed, unmerged and untracked entries all count as dirty", () => {
  const status = parsePorcelainV2Z(
    "# branch.head main\0" +
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      "1 .M N... 100644 100644 100644 aaa bbb src/app page.tsx\0" +
      // 2 …<X><score> <path>, with the original path in the next record
      "2 R. N... 100644 100644 100644 ccc ddd R100 lib/new.ts\0lib/old.ts\0" +
      "u UU N... 100644 100644 100644 100644 eee fff ggg conflict.ts\0" +
      "? untracked.txt\0" +
      // Ignored files are listed by `--ignored` and are never "dirty".
      "! dist/bundle.js\0"
  )
  assert.deepEqual(status.changed, [
    // A path with a space in it stays whole: the fields are counted, not split.
    "src/app page.tsx",
    "lib/new.ts",
    "conflict.ts",
    "untracked.txt",
  ])
})

test("a failed PR lookup backs off exponentially and then stops", () => {
  assert.equal(prFailureTtl(1), 20_000)
  assert.equal(prFailureTtl(2), 40_000)
  assert.equal(prFailureTtl(3), 80_000)
  // Capped: a branch nobody can look up must not wait forever to be retried.
  assert.equal(prFailureTtl(50), 15 * 60_000)
})

/* -------------------------------------------------------------------------- */
/* Against a real checkout                                                    */
/* -------------------------------------------------------------------------- */

let repo = ""
let plain = ""

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" })

before(() => {
  repo = mkdtempSync(join(tmpdir(), "git-status-"))
  plain = mkdtempSync(join(tmpdir(), "git-status-plain-"))
  git(repo, "init", "-q", "-b", "main", ".")
  git(repo, "config", "user.email", "test@example.com")
  git(repo, "config", "user.name", "Test")
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "first")
})

after(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
})

test("a folder that is not a checkout says so, and says nothing else", async () => {
  const status = await gitStatus(plain)
  assert.equal(status.isGitRepo, false)
  // A *fact*, not a transient failure: nothing to keep, nothing stale.
  assert.equal(status.stale, undefined)
})

test("a real checkout reports its branch, its dirt and its diffstat", async () => {
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n")
  writeFileSync(join(repo, "new.txt"), "x\n")
  invalidateGitStatus(repo)
  const status = await gitStatus(repo)
  assert.equal(status.isGitRepo, true)
  assert.equal(status.branch, "main")
  assert.equal(status.dirty, 2)
  assert.equal(status.insertions, 1)
  assert.equal(status.deletions, 0)
  // The untracked file has nothing to diff against but is still a changed
  // file, so it is listed with no counts rather than dropped.
  const paths = (status.files ?? []).map((file) => file.path).sort()
  assert.deepEqual(paths, ["a.txt", "new.txt"])
  const edited = status.files?.find((file) => file.path === "a.txt")
  assert.deepEqual(edited, { path: "a.txt", insertions: 1, deletions: 0 })
})

test("a branch with no upstream is measured against the default branch", async () => {
  git(repo, "checkout", "-q", "-b", "feature")
  writeFileSync(join(repo, "b.txt"), "b\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "second")
  invalidateGitStatus(repo)
  const status = await gitStatus(repo)
  assert.equal(status.branch, "feature")
  assert.equal(status.hasUpstream, false)
  // One commit that `main` does not have. Nothing was fetched to learn this.
  assert.equal(status.aheadOfDefault, 1)
  assert.equal(status.ahead, 1)
  assert.equal(status.behind, 0)
})

test("a non-ASCII file name comes back raw, not C-quoted", async () => {
  git(repo, "checkout", "-q", "main")
  writeFileSync(join(repo, "café.txt"), "x\n")
  invalidateGitStatus(repo)
  const status = await gitStatus(repo)
  assert.ok(
    (status.files ?? []).some((file) => file.path === "café.txt"),
    `expected café.txt among ${JSON.stringify(status.files)}`
  )
})
