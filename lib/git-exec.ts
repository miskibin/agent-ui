import "server-only"

import { execFile } from "node:child_process"
import { access, constants } from "node:fs/promises"
import { delimiter, join } from "node:path"

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * The one way this app runs `git` (and `gh`).
 *
 * Everything that shells out to git in a user's checkout goes through here so
 * that four things are true of every call, not of the ones somebody
 * remembered:
 *
 * - **`--literal-pathspecs` is always the first argument.** A path in this app
 *   comes from a tool call, an answer or a click; git reads a path argument as
 *   a *pathspec*, so `*.bak`, `report[1].md` and `:(exclude)src` are patterns,
 *   not files. `git checkout -- '*.bak'` throws away every backup file in the
 *   repo. There is no escaping to be done — the flag is the fix.
 * - **`--no-optional-locks`.** Reading the worktree must never take the index
 *   lock out from under the user or the agent.
 * - **The output is bounded.** A `maxBuffer` a slow monorepo cannot blow past,
 *   with the partial output handed back and flagged `truncated` so a caller
 *   can drop the record it cut in half rather than parse it.
 * - **Nothing can block on a human.** No credential prompt, no pager, no
 *   locale-dependent messages the classifier below would then fail to read.
 *
 * Failures are *classified*, not collapsed. "Not a git repository" is a fact
 * about the folder; a timeout, an index lock or a broken submodule is a fact
 * about this moment, and the two must not look alike — a sidebar that treats a
 * one-second hiccup as "not a repo" throws away a badge the user was reading.
 */

/** Enough for a very dirty tree; past this a caller wants a bounded read. */
export const MAX_GIT_OUTPUT = 512 * 1024

/** Two minutes of `git ls-files` in a monorepo, and then some. */
export const MAX_GIT_FILE_LIST_OUTPUT = 16 * 1024 * 1024

/**
 * Config a *read* forces off.
 *
 * `core.fsmonitor` starts a daemon and `core.untrackedCache` writes the index;
 * neither belongs in a poll the user never asked for. `core.quotePath=false`
 * is the one that changes what we parse: with it on, git C-quotes any path
 * outside ASCII (`"caf\303\251.txt"`), and every consumer here would then have
 * to unescape it. Off, the bytes come back as they are.
 */
export const GIT_READ_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.quotePath=false",
] as const

/**
 * `LC_ALL=C` is not cosmetic: `classifyGitStderr` below matches English git
 * messages, and a localized git would make every failure read as "other".
 */
const GIT_ENV = {
  LC_ALL: "C",
  LANG: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_OPTIONAL_LOCKS: "0",
} as const

const GH_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
  CLICOLOR: "0",
} as const

/**
 * Where a git binary normally lives, tried before the user's PATH — the same
 * list `lib/handoff/snapshot.ts` pins itself to, and for the same reason: the
 * command that runs after every turn should not depend on a PATH the shell
 * that launched the app happened to have.
 */
const KNOWN_GIT_LOCATIONS =
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files\\Git\\bin\\git.exe",
        "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      ]
    : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/bin/git"]

let gitBinary: Promise<string | null> | undefined

/** Absolute path of the git binary, resolved once per process; null = none. */
export function resolveGit(): Promise<string | null> {
  gitBinary ??= (async () => {
    const exe = process.platform === "win32" ? "git.exe" : "git"
    const fromPath = (process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, exe))
    for (const candidate of [...KNOWN_GIT_LOCATIONS, ...fromPath]) {
      const ok = await access(candidate, constants.X_OK).then(
        () => true,
        () => false
      )
      if (ok) return candidate
    }
    return null
  })()
  return gitBinary
}

export type GitFailureKind =
  /** No git on this machine at all. */
  | "missing-git"
  /** The folder is not inside a work tree — a fact, not a hiccup. */
  | "not-a-repo"
  /** `HEAD` names nothing yet: a repo with no commits. */
  | "unborn-head"
  /** `index.lock` is held, or git said so. Transient by definition. */
  | "locked"
  /** The command ran out of its time budget. */
  | "timeout"
  /** More output than the caller was willing to buffer. */
  | "output-limit"
  /** Anything else — a broken submodule, dubious ownership, a bad ref. */
  | "failed"

export type GitRun = {
  ok: boolean
  /** Only meaningful when `ok` is false. */
  kind?: GitFailureKind
  stdout: string
  stderr: string
  exitCode: number | null
  /** The output hit `maxBuffer`; the tail of `stdout` may be half a record. */
  truncated: boolean
}

/** A failure the caller should treat as "ask again in a moment", not as truth. */
export function isTransientGitFailure(kind: GitFailureKind | undefined) {
  return kind === "locked" || kind === "timeout" || kind === "failed"
}

/**
 * What git's stderr says went wrong, in English (hence `LC_ALL=C`).
 *
 * Adapted from T3 Code's `isNonRepositoryGitStderr` / `isUnbornHeadStderr`.
 */
export function classifyGitStderr(stderr: string): GitFailureKind | null {
  const normalized = stderr.toLowerCase()
  if (!normalized.trim()) return null
  if (
    normalized.includes("not a git repository") ||
    normalized.includes("this operation must be run in a work tree")
  ) {
    return "not-a-repo"
  }
  if (
    normalized.includes("bad revision 'head'") ||
    normalized.includes('bad revision "head"') ||
    (normalized.includes("unknown revision") &&
      normalized.includes("path not in the working tree")) ||
    normalized.includes("does not have any commits yet")
  ) {
    return "unborn-head"
  }
  if (
    normalized.includes("index.lock") ||
    normalized.includes("unable to create") ||
    normalized.includes("another git process seems to be running")
  ) {
    return "locked"
  }
  return null
}

/** A tiny counting semaphore: `git` and `gh` each get their own. */
function semaphore(limit: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((wake) => waiting.push(wake))
    active++
    try {
      return await task()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

/**
 * A global bound, not a per-folder one: eight chats polling four checkouts is
 * eight `git status` processes, and the machine the agent is working on is the
 * same one this app is being watched from.
 */
const gitLimit = semaphore(8)
/** `gh` reaches the network; four is already generous for a sidebar. */
const ghLimit = semaphore(4)

export type GitRunOptions = {
  cwd: string
  timeoutMs?: number
  maxBuffer?: number
  /** Merged over the hardened defaults — `GIT_INDEX_FILE`, an author identity. */
  env?: Record<string, string>
  /**
   * Off for a command that *writes*: `core.untrackedCache=false` and friends
   * are a read-path nicety, and a capture wants git's own configuration.
   */
  readOnlyConfig?: boolean
}

function spawn(
  binary: string,
  args: string[],
  options: {
    cwd: string
    timeout: number
    maxBuffer: number
    env: NodeJS.ProcessEnv
  }
): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      /*turbopackIgnore: true*/ binary,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
        encoding: "utf8",
        env: options.env,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout, stderr, exitCode: 0, truncated: false })
          return
        }
        const err = error as NodeJS.ErrnoException & {
          killed?: boolean
          signal?: string | null
        }
        // Order matters: blowing past `maxBuffer` also sets `killed`, and a
        // missing binary carries no stderr worth classifying.
        const kind: GitFailureKind =
          err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "output-limit"
            : err.code === "ENOENT"
              ? "missing-git"
              : err.killed || err.code === "ETIMEDOUT"
                ? "timeout"
                : (classifyGitStderr(stderr) ?? "failed")
        resolve({
          ok: false,
          kind,
          stdout,
          stderr,
          exitCode: typeof err.code === "number" ? err.code : null,
          truncated: kind === "output-limit",
        })
      }
    )
  })
}

/**
 * One `git` invocation, hardened. Never throws: every outcome is a `GitRun`,
 * because every caller here degrades rather than fails.
 */
export async function runGit(
  args: readonly string[],
  options: GitRunOptions
): Promise<GitRun> {
  const binary = await resolveGit()
  if (!binary) {
    return {
      ok: false,
      kind: "missing-git",
      stdout: "",
      stderr: "",
      exitCode: null,
      truncated: false,
    }
  }
  const full = [
    "--no-optional-locks",
    // First, always. See the note at the top of this file.
    "--literal-pathspecs",
    ...(options.readOnlyConfig === false ? [] : GIT_READ_CONFIG_ARGS),
    ...args,
  ]
  return gitLimit(() =>
    spawn(binary, full, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 5_000,
      maxBuffer: options.maxBuffer ?? MAX_GIT_OUTPUT,
      env: { ...process.env, ...GIT_ENV, ...options.env },
    })
  )
}

/** The same, for `gh` — its own concurrency bound, since it hits the network. */
export function runGh(
  args: readonly string[],
  options: GitRunOptions
): Promise<GitRun> {
  return ghLimit(() =>
    spawn(process.platform === "win32" ? "gh.exe" : "gh", [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 6_000,
      maxBuffer: options.maxBuffer ?? MAX_GIT_OUTPUT,
      env: { ...process.env, ...GH_ENV, ...options.env },
    })
  )
}

/**
 * NUL-separated git output → the records it holds.
 *
 * The last record of a *truncated* read is whatever the buffer cut in half, so
 * it is dropped: half a path is worse than a missing one.
 */
export function splitNullSeparated(stdout: string, truncated: boolean): string[] {
  const parts = stdout.split("\0")
  if (truncated && parts[parts.length - 1]?.length) parts.pop()
  return parts.filter((value) => value.length > 0)
}

/** One row of `git diff --numstat`: a file and how much of it moved. */
export type NumstatFile = {
  path: string
  insertions: number
  deletions: number
}

/**
 * `git diff --numstat -z` → one row per file.
 *
 * Ported from T3 Code's `parseTurnDiffFilesFromNumstat`. The `-z` form is the
 * only one worth parsing: the newline form quotes non-ASCII paths and writes a
 * rename as `a/{b => c}.ts`, which no amount of splitting recovers reliably.
 * Here a rename is three records — the counts with an *empty* path, then the
 * source, then the destination — and the destination is the one that counts.
 */
export function parseNumstatZ(stdout: string): NumstatFile[] {
  const records = stdout.split("\0")
  const files: NumstatFile[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record)
    if (!counts) continue
    let filePath = record.slice(counts[0].length)
    if (filePath.length === 0) {
      // Renames and copies use two more records: the source and destination.
      filePath = records[index + 2] ?? ""
      index += 2
    }
    if (filePath.length === 0) continue
    files.push({
      path: filePath,
      // "-" is git's marker for a binary file: no line counts to give.
      insertions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2]),
    })
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}
