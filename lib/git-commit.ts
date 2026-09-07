import "server-only"

import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import { realPath } from "@/lib/fs-roots"
import { runGit, MAX_GIT_OUTPUT } from "@/lib/git-exec"
import { parseJsonObject } from "@/lib/json-rescue"

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * Committing the work a chat produced, with a message written for it.
 *
 * The whole point of this file is that the *message* is the hard part. Staging
 * and `git commit` are three lines; what makes a commit worth having is a
 * subject that says what changed, in the shape this repository already uses.
 * So the evidence gathered here is deliberately more than the diff:
 *
 * - **What is staged**, twice — a `--name-status` summary that survives a huge
 *   change, and a `--patch --minimal` body that says what actually moved. Both
 *   are capped, because a prompt that overflows is a prompt that gets cut
 *   somewhere arbitrary; capping here means the cut is at a record boundary we
 *   chose.
 * - **The repository's own conventions**: the last twenty subjects, and its
 *   `AGENTS.md` / `CLAUDE.md` if it has one. A repo that writes
 *   `fix(store): …` and one that writes `Fix the store` are both consistent,
 *   and neither is improved by having a house style imposed on it.
 *
 * Everything shells out through `lib/git-exec`, so `--literal-pathspecs` is in
 * front of every path argument — the paths here come from a chat's change
 * card, i.e. from tool calls and from answers, and to git `report[1].md` is a
 * character class. See the note at the top of `app/api/git/revert`.
 *
 * Nothing in this file throws: git failures come back as values, because every
 * caller is a route that has to turn them into a message a user can act on.
 */

/** `--name-status` past this is not evidence any more, it is noise. */
export const MAX_SUMMARY_CHARS = 8_000
/** The patch is the expensive half of the prompt; this is its share. */
export const MAX_PATCH_CHARS = 50_000
/** The subject line git itself, GitHub and every log viewer expect. */
export const MAX_SUBJECT_CHARS = 72
/** What a commit is called when the message came back empty. */
export const FALLBACK_SUBJECT = "Update project files"
/** An instructions file larger than this is a document, not a convention. */
export const MAX_INSTRUCTIONS_BYTES = 20_000

/** Staging a cold monorepo is not a five-second operation. */
const WRITE_TIMEOUT_MS = 60_000
/** And `git commit` runs the repository's own hooks, which may do anything. */
const COMMIT_TIMEOUT_MS = 120_000
const READ_TIMEOUT_MS = 15_000
const QUICK_TIMEOUT_MS = 5_000
/** A push reaches the network. */
const PUSH_TIMEOUT_MS = 120_000

/** Cut to a budget, on a line boundary, with the cut marked. */
function limit(text: string, max: number) {
  if (text.length <= max) return text
  const clipped = text.slice(0, max)
  const lastBreak = clipped.lastIndexOf("\n")
  const kept = lastBreak > max / 2 ? clipped.slice(0, lastBreak) : clipped
  return `${kept.trimEnd()}\n[truncated]`
}

/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

export type CommitContext = {
  /** `git diff --cached --name-status`, capped. */
  summary: string
  /** `git diff --cached --patch --minimal`, capped. */
  patch: string
  /** True when staging produced nothing: there is no commit to make. */
  nothingStaged: boolean
}

/**
 * Stages what is about to be committed and reads it back.
 *
 * With `paths`, the index is **reset first**. That is deliberate and it is the
 * one destructive thing here: "commit these three files" has to mean those
 * three and not those three plus whatever was already staged, and a chat's
 * change card is precisely a list of files the user is choosing between. With
 * no paths at all it is `add -A` — everything, untracked included, which is
 * what "commit the agent's work" means when the agent created files.
 */
export async function prepareCommitContext(
  cwd: string,
  paths?: readonly string[]
): Promise<CommitContext> {
  if (paths && paths.length > 0) {
    // A failure here is not fatal: an unborn repo has no index to reset.
    await runGit(["reset", "--quiet"], {
      cwd,
      timeoutMs: WRITE_TIMEOUT_MS,
      readOnlyConfig: false,
    })
    await runGit(["add", "-A", "--", ...paths], {
      cwd,
      timeoutMs: WRITE_TIMEOUT_MS,
      readOnlyConfig: false,
    })
  } else {
    await runGit(["add", "-A"], {
      cwd,
      timeoutMs: WRITE_TIMEOUT_MS,
      readOnlyConfig: false,
    })
  }

  const summaryRun = await runGit(["diff", "--cached", "--name-status"], {
    cwd,
    timeoutMs: READ_TIMEOUT_MS,
  })
  const summary = summaryRun.ok ? summaryRun.stdout.trim() : ""
  if (!summary) return { summary: "", patch: "", nothingStaged: true }

  const patchRun = await runGit(
    ["diff", "--no-ext-diff", "--cached", "--patch", "--minimal"],
    { cwd, timeoutMs: READ_TIMEOUT_MS, maxBuffer: MAX_GIT_OUTPUT }
  )
  return {
    summary: limit(summary, MAX_SUMMARY_CHARS),
    patch: limit(patchRun.ok ? patchRun.stdout.trim() : "", MAX_PATCH_CHARS),
    nothingStaged: false,
  }
}

/**
 * The repository's own instructions for people working in it — `AGENTS.md`,
 * else `CLAUDE.md`. Bounded by size and by *real* path: a symlinked
 * `AGENTS.md` pointing at `~/.ssh/config` must not become prompt text.
 */
export async function readRepositoryInstructions(cwd: string): Promise<string> {
  const root = await realPath(cwd)
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const file = await realPath(path.join(root, name))
    if (!file.startsWith(root + path.sep)) continue
    try {
      const info = await stat(file)
      if (!info.isFile() || info.size > MAX_INSTRUCTIONS_BYTES) continue
      const text = (await readFile(file, "utf8")).trim()
      if (text) return text
    } catch {
      /* not there, or not readable — try the next name */
    }
  }
  return ""
}

/** The last `limitCount` commit subjects, newest first; [] when there are none. */
export async function readRecentCommitSubjects(
  cwd: string,
  limitCount = 20
): Promise<string[]> {
  const run = await runGit(
    ["log", "-n", String(limitCount), "--no-merges", "--pretty=format:%s"],
    { cwd, timeoutMs: READ_TIMEOUT_MS }
  )
  if (!run.ok) return []
  return run.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

/* -------------------------------------------------------------------------- */
/* The prompt                                                                  */
/* -------------------------------------------------------------------------- */

export type CommitStyle = "conventional" | "repo-conventions" | "custom"

export type CommitPromptInput = {
  style: CommitStyle
  /** `AGENTS.md` / `CLAUDE.md`, for `repo-conventions`. */
  instructions?: string
  /** Recent subjects, for `repo-conventions`. */
  subjects?: readonly string[]
  summary: string
  patch: string
  /** The user's own house rules, for `custom`. */
  custom?: string
  branch?: string | null
}

/** What each style asks for, beyond the rules every style shares. */
function styleRules(input: CommitPromptInput): string[] {
  if (input.style === "conventional") {
    return [
      "Follow Conventional Commits: `type(scope): summary`.",
      "Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore.",
      "The scope is optional and is a directory or module name, never a file path.",
    ]
  }
  if (input.style === "custom") {
    const custom = input.custom?.trim()
    return custom ? ["Follow these instructions exactly:", custom] : []
  }
  const lines = [
    "Match the style this repository already uses — its tense, its capitalization, its prefixes.",
    "Imitate the examples below rather than imposing a convention they do not follow.",
  ]
  const subjects = (input.subjects ?? []).slice(0, 20)
  if (subjects.length) {
    lines.push("", "Recent commit subjects from this repository:", ...subjects)
  }
  const instructions = input.instructions?.trim()
  if (instructions) {
    lines.push(
      "",
      "The repository's own instructions file:",
      limit(instructions, MAX_INSTRUCTIONS_BYTES)
    )
  }
  return lines
}

/**
 * The two halves of one completion: rules, then evidence.
 *
 * Pure, and exported for the tests — a prompt is the only part of this that
 * cannot be checked by running git.
 *
 * Adapted from T3 Code's `buildCommitMessagePrompt`. The rule that earns its
 * place is the last one: a staged diff contains every incidental edit of the
 * turn, and a message that lists them ("update imports, bump version, fix
 * typo") is a worse record than one naming the change they were all in service
 * of.
 */
export function buildCommitMessagePrompt(input: CommitPromptInput): {
  system: string
  user: string
} {
  const system = [
    "You write git commit messages.",
    'Reply with JSON with exactly two keys: {"subject": "…", "body": "…"}.',
    "",
    "Rules:",
    `- subject is imperative, at most ${MAX_SUBJECT_CHARS} characters, and carries no trailing period.`,
    "- body is either an empty string or a few short lines; wrap at 72 characters.",
    "- Describe the change, not the process that produced it.",
    "- Name the one user-visible or developer-visible change the diff is in service of, not every edit in it.",
    ...styleRules(input),
  ].join("\n")

  const user = [
    `Branch: ${input.branch?.trim() || "(detached)"}`,
    "",
    "Staged files:",
    limit(input.summary, MAX_SUMMARY_CHARS),
    "",
    "Staged patch:",
    limit(input.patch, MAX_PATCH_CHARS),
  ].join("\n")

  return { system, user }
}

/* -------------------------------------------------------------------------- */
/* The message                                                                 */
/* -------------------------------------------------------------------------- */

export type CommitMessage = {
  subject: string
  body: string
  /** Subject, then a blank line, then the body — what git is handed. */
  message: string
}

/** Subject and body joined the way `git log` expects to find them. */
export function formatCommitMessage(subject: string, body: string): string {
  const trimmed = body.trim()
  return trimmed ? `${subject}\n\n${trimmed}` : subject
}

/**
 * Whatever came back, as a commit message.
 *
 * The JSON is unwrapped before anything is measured — the same order
 * `sanitizeTitle` uses, and for the same reason: prose wrapped around a JSON
 * object would otherwise be truncated into a subject reading `{"subject": "Fix
 * the stre`. Plain text is treated as the message itself, which is also what
 * makes this the right function for a message the *user* typed.
 *
 * Adapted from T3 Code's `sanitizeCommitMessage`.
 */
export function sanitizeCommitMessage(raw: string): CommitMessage {
  const parsed = parseJsonObject<{ subject?: unknown; body?: unknown }>(raw)
  const subjectSource =
    typeof parsed?.subject === "string" ? parsed.subject : raw
  const bodySource = typeof parsed?.body === "string" ? parsed.body : ""

  const lines = subjectSource.replace(/\r\n/g, "\n").split("\n")
  const firstIndex = lines.findIndex((line) => line.trim())
  const firstLine = firstIndex < 0 ? "" : lines[firstIndex].trim()
  // Text that was never JSON carries its own body: everything after line one.
  const rest =
    typeof parsed?.subject === "string"
      ? ""
      : lines.slice(firstIndex + 1).join("\n")

  const subject =
    firstLine
      .replace(/^["'`\s]+|["'`\s]+$/g, "")
      .replace(/\.+$/, "")
      .trim()
      .slice(0, MAX_SUBJECT_CHARS)
      .trimEnd() || FALLBACK_SUBJECT
  const body = (bodySource || rest).trim()
  return { subject, body, message: formatCommitMessage(subject, body) }
}

/** One completion, injected — which is what makes the generator testable. */
export type CompleteFn = (prompt: {
  system: string
  user: string
}) => Promise<string>

/**
 * Reads the repository, builds the prompt, asks, and sanitizes the answer.
 *
 * The completion is a parameter rather than an import: the route knows which
 * models this app can reach (the chat's own, else the memory model — see
 * `lib/completion.ts`), and the tests know none of that and should not have to.
 */
export async function generateCommitMessage(input: {
  cwd: string
  context: CommitContext
  complete: CompleteFn
  style?: CommitStyle
  custom?: string
  branch?: string | null
}): Promise<CommitMessage> {
  const style = input.style ?? "repo-conventions"
  const [subjects, instructions] =
    style === "repo-conventions"
      ? await Promise.all([
          readRecentCommitSubjects(input.cwd),
          readRepositoryInstructions(input.cwd),
        ])
      : [[] as string[], ""]

  const prompt = buildCommitMessagePrompt({
    style,
    subjects,
    instructions,
    summary: input.context.summary,
    patch: input.context.patch,
    ...(input.custom ? { custom: input.custom } : null),
    branch: input.branch ?? null,
  })
  return sanitizeCommitMessage(await input.complete(prompt))
}

/* -------------------------------------------------------------------------- */
/* Branches                                                                    */
/* -------------------------------------------------------------------------- */

/** The checked-out branch, or "" when HEAD is detached or unborn. */
export async function currentBranch(cwd: string): Promise<string> {
  const run = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    timeoutMs: QUICK_TIMEOUT_MS,
  })
  return run.ok ? run.stdout.trim() : ""
}

/**
 * The branch this repository treats as its trunk: what `origin/HEAD` names,
 * else whichever of `main` / `master` exists. "" when neither does — a repo
 * with no remote and a branch called something else has no trunk to protect.
 */
export async function defaultBranch(cwd: string): Promise<string> {
  const head = await runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
    cwd,
    timeoutMs: QUICK_TIMEOUT_MS,
  })
  const named = head.ok ? head.stdout.trim() : ""
  if (named.startsWith("refs/remotes/origin/")) {
    return named.slice("refs/remotes/origin/".length)
  }
  for (const candidate of ["main", "master"]) {
    const found = await runGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`],
      { cwd, timeoutMs: QUICK_TIMEOUT_MS }
    )
    if (found.ok && found.stdout.trim()) return candidate
  }
  return ""
}

/* -------------------------------------------------------------------------- */
/* Commit and push                                                             */
/* -------------------------------------------------------------------------- */

export type CommitResult =
  | { ok: true; sha: string; subject: string; message: string }
  | { ok: false; error: string; needsConfirmation?: "default-branch"; branch?: string }

export type CommitOptions = {
  /**
   * Committing straight onto `main` is usually a mistake and occasionally the
   * whole point, so it is a confirmation rather than a refusal: the first call
   * comes back with `needsConfirmation`, and the second one carries this.
   */
  allowDefaultBranch?: boolean
}

/**
 * `git commit` with the message already decided.
 *
 * Subject and body go in as two separate `-m` arguments — git joins them with
 * the blank line that makes them a subject and a body, and neither is ever
 * interpolated into a shell.
 */
export async function commit(
  cwd: string,
  message: string,
  options: CommitOptions = {}
): Promise<CommitResult> {
  const { subject, body } = sanitizeCommitMessage(message)

  if (!options.allowDefaultBranch) {
    const [branch, trunk] = await Promise.all([
      currentBranch(cwd),
      defaultBranch(cwd),
    ])
    if (branch && trunk && branch === trunk) {
      return {
        ok: false,
        error: `${branch} is this repository's default branch`,
        needsConfirmation: "default-branch",
        branch,
      }
    }
  }

  // Hooks run: a repository that formats or lints on commit is expressing a
  // convention, and skipping it would make this app the one client that
  // commits unformatted code.
  const run = await runGit(
    ["commit", "-m", subject, ...(body ? ["-m", body] : [])],
    { cwd, timeoutMs: COMMIT_TIMEOUT_MS, readOnlyConfig: false }
  )
  if (!run.ok) {
    const detail = (run.stderr.trim() || run.stdout.trim()).slice(0, 500)
    return { ok: false, error: detail || "git commit failed" }
  }
  const head = await runGit(["rev-parse", "HEAD"], {
    cwd,
    timeoutMs: QUICK_TIMEOUT_MS,
  })
  return {
    ok: true,
    sha: head.ok ? head.stdout.trim() : "",
    subject,
    message: formatCommitMessage(subject, body),
  }
}

export type PushFailure =
  /** A credential problem: no token, no key, or one that is not allowed here. */
  | "auth"
  /** The remote moved on — the branch needs a pull or a rebase first. */
  | "rejected"
  /** No `origin` to push to. */
  | "no-remote"
  /** Nothing is checked out to push. */
  | "detached"
  | "failed"

export type PushResult =
  | { ok: true; branch: string; created: boolean }
  | { ok: false; kind: PushFailure; error: string }

/**
 * What git's stderr says a failed push failed of.
 *
 * `GIT_TERMINAL_PROMPT=0` (set for every command in `lib/git-exec`) is what
 * makes this classifiable at all: without it a push with no credentials hangs
 * on a username prompt in a process nobody can type into, and the app reports a
 * timeout for what is really "you are not signed in".
 */
export function classifyPushFailure(stderr: string): PushFailure {
  const text = stderr.toLowerCase()
  if (
    text.includes("authentication failed") ||
    text.includes("could not read username") ||
    text.includes("could not read password") ||
    text.includes("terminal prompts disabled") ||
    text.includes("permission denied (publickey)") ||
    text.includes("access denied") ||
    text.includes("403") ||
    text.includes("invalid username or token")
  ) {
    return "auth"
  }
  if (
    text.includes("non-fast-forward") ||
    text.includes("fetch first") ||
    text.includes("[rejected]") ||
    text.includes("updates were rejected")
  ) {
    return "rejected"
  }
  if (
    text.includes("does not appear to be a git repository") ||
    text.includes("no such remote") ||
    text.includes("could not read from remote repository")
  ) {
    return "no-remote"
  }
  return "failed"
}

/**
 * Pushes the current branch, creating its upstream on the first push.
 *
 * A branch the agent just made has no upstream, and a bare `git push` on one
 * either fails or — under `push.autoSetupRemote` — quietly does something else
 * depending on the user's config. Naming `origin <branch>` and setting the
 * upstream makes the first push mean one thing.
 */
export async function push(cwd: string): Promise<PushResult> {
  const branch = await currentBranch(cwd)
  if (!branch) {
    return {
      ok: false,
      kind: "detached",
      error: "HEAD is detached — check out a branch before pushing",
    }
  }
  const upstream = await runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd, timeoutMs: QUICK_TIMEOUT_MS }
  )
  const created = !(upstream.ok && upstream.stdout.trim())
  const args = created
    ? ["push", "--set-upstream", "origin", branch]
    : ["push"]
  const run = await runGit(args, {
    cwd,
    timeoutMs: PUSH_TIMEOUT_MS,
    readOnlyConfig: false,
  })
  if (!run.ok) {
    const stderr = run.stderr.trim() || run.stdout.trim()
    return {
      ok: false,
      kind: run.kind === "timeout" ? "failed" : classifyPushFailure(stderr),
      error: stderr.slice(0, 500) || "git push failed",
    }
  }
  return { ok: true, branch, created }
}
