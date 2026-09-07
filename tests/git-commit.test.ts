import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import {
  buildCommitMessagePrompt,
  classifyPushFailure,
  commit,
  currentBranch,
  defaultBranch,
  formatCommitMessage,
  generateCommitMessage,
  prepareCommitContext,
  readRecentCommitSubjects,
  readRepositoryInstructions,
  sanitizeCommitMessage,
  FALLBACK_SUBJECT,
  MAX_SUBJECT_CHARS,
} from "@/lib/git-commit"

/**
 * Committing what a chat changed, against a real checkout — because every
 * claim worth making here is a claim about what git did with the index.
 *
 * The message half is checked without a model: `generateCommitMessage` takes
 * its completion as a parameter precisely so the test can be the one that
 * answers, and so the prompt it was handed can be inspected.
 */

let repo = ""
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" })
const write = (name: string, text: string) =>
  writeFileSync(join(repo, name), text)

before(() => {
  repo = mkdtempSync(join(tmpdir(), "git-commit-"))
  git("init", "-q", "-b", "main", ".")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  git("config", "commit.gpgsign", "false")
  write("a.txt", "one\n")
  git("add", "-A")
  git("commit", "-qm", "Add a.txt")
})

after(() => rmSync(repo, { recursive: true, force: true }))

test("a clean tree stages nothing and says so", async () => {
  const context = await prepareCommitContext(repo)
  assert.equal(context.nothingStaged, true)
  assert.equal(context.summary, "")
})

test("staging picks up edits and new files, with a patch", async () => {
  write("a.txt", "one\ntwo\n")
  write("new.txt", "fresh\n")
  const context = await prepareCommitContext(repo)
  assert.equal(context.nothingStaged, false)
  assert.match(context.summary, /^M\s+a\.txt$/m)
  assert.match(context.summary, /^A\s+new\.txt$/m)
  assert.match(context.patch, /\+two/)
})

test("named paths are the only ones staged, whatever was staged before", async () => {
  // Everything is staged from the previous test; naming one file has to undo
  // that, or "commit these files" would quietly commit the others too.
  const context = await prepareCommitContext(repo, ["new.txt"])
  assert.equal(context.nothingStaged, false)
  assert.match(context.summary, /new\.txt/)
  assert.doesNotMatch(context.summary, /a\.txt/)
})

test("a commit lands on HEAD with the subject and body git expects", async () => {
  await prepareCommitContext(repo)
  const result = await commit(repo, 'Add two more files\n\nBecause the test said so.', {
    // main is the default branch here; the guard is checked separately.
    allowDefaultBranch: true,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.match(result.sha, /^[0-9a-f]{40}$/)
  assert.equal(git("log", "-1", "--pretty=format:%s").trim(), "Add two more files")
  assert.equal(
    git("log", "-1", "--pretty=format:%b").trim(),
    "Because the test said so."
  )
})

test("the default branch is a confirmation, not a refusal", async () => {
  write("a.txt", "one\ntwo\nthree\n")
  await prepareCommitContext(repo)
  assert.equal(await currentBranch(repo), "main")
  assert.equal(await defaultBranch(repo), "main")

  const held = await commit(repo, "Extend a.txt")
  assert.equal(held.ok, false)
  if (held.ok) return
  assert.equal(held.needsConfirmation, "default-branch")
  assert.equal(held.branch, "main")
  // Nothing was committed by the refusal.
  assert.equal(git("log", "-1", "--pretty=format:%s").trim(), "Add two more files")

  const confirmed = await commit(repo, "Extend a.txt", { allowDefaultBranch: true })
  assert.equal(confirmed.ok, true)
  assert.equal(git("log", "-1", "--pretty=format:%s").trim(), "Extend a.txt")
})

test("a branch that is not the trunk needs no confirmation", async () => {
  git("checkout", "-q", "-b", "feature/thing")
  write("b.txt", "b\n")
  await prepareCommitContext(repo)
  const result = await commit(repo, "Add b.txt")
  assert.equal(result.ok, true)
  git("checkout", "-q", "main")
})

test("recent subjects come back newest first", async () => {
  const subjects = await readRecentCommitSubjects(repo, 5)
  assert.equal(subjects[0], "Extend a.txt")
  assert.ok(subjects.includes("Add a.txt"))
})

test("the repository's instructions are read, and bounded to it", async () => {
  assert.equal(await readRepositoryInstructions(repo), "")
  write("CLAUDE.md", "House style: shout.\n")
  assert.equal(await readRepositoryInstructions(repo), "House style: shout.")
  // AGENTS.md wins when both exist: it is the vendor-neutral name.
  write("AGENTS.md", "House style: whisper.\n")
  assert.equal(await readRepositoryInstructions(repo), "House style: whisper.")
  git("add", "-A")
  git("commit", "-qm", "Add instructions")
})

test("a subject is one line, trimmed of its full stop, and capped", () => {
  const long = "x".repeat(200)
  const sanitized = sanitizeCommitMessage(long)
  assert.equal(sanitized.subject.length, MAX_SUBJECT_CHARS)
  assert.equal(sanitizeCommitMessage("Fix the parser.").subject, "Fix the parser")
  assert.equal(sanitizeCommitMessage("   \n\n  ").subject, FALLBACK_SUBJECT)
})

test("plain text keeps its body, after the blank line", () => {
  const sanitized = sanitizeCommitMessage("Fix the parser\n\n- handle EOF\n- add a test")
  assert.equal(sanitized.subject, "Fix the parser")
  assert.equal(sanitized.body, "- handle EOF\n- add a test")
  assert.equal(sanitized.message, "Fix the parser\n\n- handle EOF\n- add a test")
})

test("JSON is unwrapped before anything is measured", () => {
  const raw = 'Sure!\n{"subject": "Add the commit route", "body": "Stages and commits."}'
  const sanitized = sanitizeCommitMessage(raw)
  assert.equal(sanitized.subject, "Add the commit route")
  assert.equal(sanitized.body, "Stages and commits.")
  assert.equal(formatCommitMessage(sanitized.subject, ""), "Add the commit route")
})

test("each style asks for what it says it asks for", () => {
  const base = { summary: "M\ta.txt", patch: "+two", branch: "feature/x" }
  const conventional = buildCommitMessagePrompt({ ...base, style: "conventional" })
  assert.match(conventional.system, /Conventional Commits/)
  assert.match(conventional.user, /feature\/x/)
  assert.match(conventional.user, /a\.txt/)

  const custom = buildCommitMessagePrompt({
    ...base,
    style: "custom",
    custom: "Always start with a ticket id.",
  })
  assert.match(custom.system, /Always start with a ticket id\./)
  assert.doesNotMatch(custom.system, /Conventional Commits/)

  const repoStyle = buildCommitMessagePrompt({
    ...base,
    style: "repo-conventions",
    subjects: ["Add a.txt", "Extend a.txt"],
    instructions: "House style: whisper.",
  })
  assert.match(repoStyle.system, /Extend a\.txt/)
  assert.match(repoStyle.system, /House style: whisper\./)
})

test("the generator sees the repo's own conventions, and sanitizes the answer", async () => {
  write("c.txt", "c\n")
  const context = await prepareCommitContext(repo)
  let seen = { system: "", user: "" }
  const written = await generateCommitMessage({
    cwd: repo,
    context,
    branch: "main",
    style: "repo-conventions",
    complete: async (prompt) => {
      seen = prompt
      return '{"subject": "Add c.txt.", "body": ""}'
    },
  })
  // The last twenty subjects and the instructions file, without being asked for.
  assert.match(seen.system, /Add instructions/)
  assert.match(seen.system, /House style: whisper\./)
  assert.match(seen.user, /c\.txt/)
  assert.equal(written.subject, "Add c.txt")
  assert.equal(written.message, "Add c.txt")
})

test("push failures are told apart", () => {
  assert.equal(
    classifyPushFailure("fatal: could not read Username for 'https://github.com'"),
    "auth"
  )
  assert.equal(
    classifyPushFailure("remote: Permission denied (publickey)."),
    "auth"
  )
  assert.equal(
    classifyPushFailure(" ! [rejected] main -> main (non-fast-forward)"),
    "rejected"
  )
  assert.equal(
    classifyPushFailure("fatal: 'origin' does not appear to be a git repository"),
    "no-remote"
  )
  assert.equal(classifyPushFailure("something else entirely"), "failed")
})
