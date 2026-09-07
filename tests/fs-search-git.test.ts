import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { invalidateWalk, resolveInRoot, walkCached } from "@/lib/fs-search"

/**
 * In a checkout, the file list behind `@` and behind every "which file did the
 * answer mean" repair comes from git rather than from a hand-written walk.
 *
 * The difference is not speed, it is *correctness*: `SKIP_DIRS` is a guess at
 * what a project considers noise, and every project it guesses wrong about
 * gets a menu full of build output. `git ls-files --others --exclude-standard`
 * asks the repository, which already answered the question in `.gitignore`.
 */

let repo = ""
let plain = ""

const write = (root: string, relative: string, text = "x") => {
  const full = join(root, ...relative.split("/"))
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, text)
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "fs-search-git-"))
  plain = mkdtempSync(join(tmpdir(), "fs-search-plain-"))
  execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: repo })
  write(repo, ".gitignore", "generated/\n*.log\n")
  write(repo, "src/app.ts")
  write(repo, "src/Messages.tsx")
  write(repo, "generated/schema.ts")
  write(repo, "debug.log")
  // A directory `SKIP_DIRS` names but this project actually tracks.
  write(repo, "vendor/lib.ts")

  write(plain, "src/app.ts")
  write(plain, "node_modules/pkg/index.js")
})

after(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
})

test("the list honours .gitignore, including files git has never seen", async () => {
  const { files } = await walkCached(repo)
  assert.equal(files.includes("src/app.ts"), true)
  assert.equal(files.includes(".gitignore"), true)
  // Ignored by the project's own rules, tracked by nothing.
  assert.equal(files.includes("generated/schema.ts"), false)
  assert.equal(files.includes("debug.log"), false)
})

test("a directory the hand-written skip list names is still listed when the repo tracks it", async () => {
  const { files } = await walkCached(repo)
  // `vendor` is in SKIP_DIRS. In a repo that vendors its dependencies on
  // purpose, that list is simply wrong, and git is the one that knows.
  assert.equal(files.includes("vendor/lib.ts"), true)
})

test("a folder git knows nothing about still gets the hand-written walk", async () => {
  const { files } = await walkCached(plain)
  assert.equal(files.includes("src/app.ts"), true)
  // The fallback's own skip list is what keeps this usable.
  assert.equal(files.includes("node_modules/pkg/index.js"), false)
})

test("the deepest-unique-suffix repair still works over the git-backed list", async () => {
  const found = await resolveInRoot(repo, "Messages.tsx")
  assert.ok(found)
  assert.equal(found.relative, "src/Messages.tsx")
  assert.equal(found.exact, false)
})

test("a file the agent just created shows up once the folder is invalidated", async () => {
  await walkCached(repo)
  write(repo, "src/fresh.ts")
  // The cache is a half-minute window, and a turn that just wrote a file is
  // exactly when the user goes looking for it.
  invalidateWalk(repo)
  const { files } = await walkCached(repo)
  assert.equal(files.includes("src/fresh.ts"), true)
})
