import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { runGit } from "@/lib/git-exec"

/**
 * The data-loss bug `--literal-pathspecs` closes.
 *
 * "Revert changes" hands git a path that came from a tool call or an answer,
 * and git reads a path argument as a **pathspec**: `*.bak` is a glob,
 * `report[1].md` is a character class, `:(exclude)x` is magic. So a user
 * clicking Revert on one file with a bracket in its name reverted a *different*
 * file, and on one with a star in its name reverted every file that matched —
 * silently, and with no undo.
 *
 * `lib/git-exec` puts the flag in front of every command it runs, so what is
 * asserted here is the guarantee the revert route depends on rather than the
 * route's own plumbing.
 */

let repo = ""

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" })
const read = (name: string) => readFileSync(join(repo, name), "utf8")

before(() => {
  repo = mkdtempSync(join(tmpdir(), "git-revert-"))
  git("init", "-q", "-b", "main", ".")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  writeFileSync(join(repo, "report[1].md"), "committed\n")
  writeFileSync(join(repo, "report1.md"), "committed\n")
  writeFileSync(join(repo, "notes.bak"), "committed\n")
  writeFileSync(join(repo, "keep.bak"), "committed\n")
  git("add", "-A")
  git("commit", "-qm", "first")
})

after(() => rmSync(repo, { recursive: true, force: true }))

test("reverting `report[1].md` restores that file and no other", async () => {
  writeFileSync(join(repo, "report[1].md"), "edited\n")
  writeFileSync(join(repo, "report1.md"), "edited\n")

  const reverted = await runGit(["checkout", "--", "report[1].md"], {
    cwd: repo,
    readOnlyConfig: false,
  })
  assert.equal(reverted.ok, true, reverted.stderr)

  assert.equal(read("report[1].md"), "committed\n")
  // Without the flag, `report[1].md` is the character class `report1.md` —
  // git would have restored the neighbour and left the file the user clicked
  // on untouched, which is the exact inverse of what was asked for.
  assert.equal(read("report1.md"), "edited\n")
})

test("a name that is a glob reverts one file, not everything it matches", async () => {
  writeFileSync(join(repo, "notes.bak"), "edited\n")
  writeFileSync(join(repo, "keep.bak"), "edited\n")
  // A file literally named `*.bak`, which is legal on every POSIX filesystem.
  writeFileSync(join(repo, "*.bak"), "committed\n")
  git("add", "-A")
  git("commit", "-qm", "second")
  writeFileSync(join(repo, "*.bak"), "edited\n")

  const reverted = await runGit(["checkout", "--", "*.bak"], {
    cwd: repo,
    readOnlyConfig: false,
  })
  assert.equal(reverted.ok, true, reverted.stderr)

  assert.equal(read("*.bak"), "committed\n")
  assert.equal(read("notes.bak"), "edited\n")
  assert.equal(read("keep.bak"), "edited\n")
})

test("`ls-files --error-unmatch` is literal too, so the tracked check agrees", async () => {
  // The revert route refuses an untracked file. With pathspec magic on, a name
  // that merely *matches* a tracked file passes the check and the checkout
  // then acts on the match — the two commands have to read the name the same
  // way, and now they do.
  writeFileSync(join(repo, "draft[9].md"), "untracked\n")
  const tracked = await runGit(["ls-files", "--error-unmatch", "--", "draft[9].md"], {
    cwd: repo,
  })
  assert.equal(tracked.ok, false)
})
