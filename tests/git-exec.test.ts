import assert from "node:assert/strict"
import { test } from "node:test"

import {
  classifyGitStderr,
  isTransientGitFailure,
  parseNumstatZ,
  splitNullSeparated,
} from "@/lib/git-exec"

/**
 * The pure half of `lib/git-exec`: what git's stderr means, and how its
 * NUL-separated output parses.
 *
 * The classifier is the reason `LC_ALL=C` is forced on every call — every
 * string it matches is git's own English — and it is load-bearing well beyond
 * tidiness: "not a git repository" is a fact the sidebar caches, while a
 * timeout or a held index lock is a moment the sidebar has to ride out
 * *keeping* what it already knew.
 */

test("a folder that is not a checkout is told apart from everything else", () => {
  assert.equal(
    classifyGitStderr(
      "fatal: not a git repository (or any of the parent directories): .git"
    ),
    "not-a-repo"
  )
})

test("a repo with no commits reads as an unborn head, not a failure", () => {
  assert.equal(classifyGitStderr("fatal: bad revision 'HEAD'"), "unborn-head")
  assert.equal(
    classifyGitStderr(
      "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."
    ),
    "unborn-head"
  )
})

test("a held index lock is recognized", () => {
  assert.equal(
    classifyGitStderr(
      "fatal: Unable to create '/repo/.git/index.lock': File exists.\n" +
        "Another git process seems to be running in this repository"
    ),
    "locked"
  )
})

test("anything unrecognized stays unclassified rather than guessed at", () => {
  assert.equal(
    classifyGitStderr("fatal: detected dubious ownership in repository at /repo"),
    null
  )
  assert.equal(classifyGitStderr("   "), null)
})

test("only the failures worth retrying are transient", () => {
  assert.equal(isTransientGitFailure("timeout"), true)
  assert.equal(isTransientGitFailure("locked"), true)
  assert.equal(isTransientGitFailure("failed"), true)
  // A folder does not become a checkout while the user waits, and a machine
  // does not grow a git binary either.
  assert.equal(isTransientGitFailure("not-a-repo"), false)
  assert.equal(isTransientGitFailure("missing-git"), false)
})

test("a truncated NUL-separated read drops the record it cut in half", () => {
  assert.deepEqual(splitNullSeparated("a.ts\0b.ts\0c.t", true), ["a.ts", "b.ts"])
  // Untruncated, a trailing record with no NUL after it is still a real path.
  assert.deepEqual(splitNullSeparated("a.ts\0b.ts\0", false), ["a.ts", "b.ts"])
  assert.deepEqual(splitNullSeparated("", false), [])
})

test("numstat rows parse, sorted by path", () => {
  const rows = parseNumstatZ("3\t1\tsrc/b.ts\0" + "10\t0\tsrc/a.ts\0")
  assert.deepEqual(rows, [
    { path: "src/a.ts", insertions: 10, deletions: 0 },
    { path: "src/b.ts", insertions: 3, deletions: 1 },
  ])
})

test("a rename is three records and the destination is the file", () => {
  // Exactly what `git diff -M --numstat -z` writes: counts with an empty
  // path, then the source, then the destination.
  const rows = parseNumstatZ("0\t0\t\0a.txt\0b.txt\0")
  assert.deepEqual(rows, [{ path: "b.txt", insertions: 0, deletions: 0 }])
})

test("a binary file's `-` counts read as zero, not NaN", () => {
  const [row] = parseNumstatZ("-\t-\tassets/logo.png\0")
  assert.deepEqual(row, { path: "assets/logo.png", insertions: 0, deletions: 0 })
})

test("a path with a space or a tab in it survives", () => {
  const rows = parseNumstatZ("1\t2\tmy docs/a\tb.md\0")
  assert.deepEqual(rows, [
    { path: "my docs/a\tb.md", insertions: 1, deletions: 2 },
  ])
})
