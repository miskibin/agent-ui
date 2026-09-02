import "server-only"

import { execFile } from "node:child_process"
import { access, constants } from "node:fs/promises"
import { delimiter, join } from "node:path"

import type { WorktreeSnapshot } from "@/lib/handoff/types"

/**
 * The cheap worktree snapshot a handoff compares against: one `rev-parse` and
 * one `status --porcelain`, nothing else.
 *
 * Deliberately *not* the temporary-index / synthetic-tree design. This never
 * stages anything, never writes a tree and never takes a lock — every call
 * carries `--no-optional-locks`, which is git's own way of saying "read, do
 * not refresh the index" — so running it after every turn cannot disturb what
 * the user or the agent has staged.
 *
 * Every failure mode is the same failure mode: no git, not a repo, a timeout,
 * a submodule the command chokes on. All of them return undefined, which the
 * builder reads as "unknown" and simply says nothing about.
 */

/** Hard ceiling per git call. A slow repo must never delay an answer. */
const GIT_TIMEOUT_MS = 1_500
/** Enough for a very dirty tree; past this the handoff would not fit anyway. */
const MAX_GIT_OUTPUT = 512 * 1024

/**
 * Where a git binary normally lives, tried before the user's PATH so the
 * command that runs after every turn is pinned to a fixed location whenever
 * one exists. PATH is only a fallback, for the odd install (a portable git on
 * Windows, a version manager) that keeps it elsewhere.
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
function resolveGit(): Promise<string | null> {
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

export async function readWorktreeSnapshot(
  cwd: string | undefined
): Promise<WorktreeSnapshot | undefined> {
  const folder = cwd?.trim()
  if (!folder) return undefined
  const [head, status] = await Promise.all([
    git(["rev-parse", "HEAD"], folder),
    git(["status", "--porcelain=v1", "--untracked-files=all"], folder),
  ])
  // `status` is the one that says "this is a repo at all"; `rev-parse` also
  // fails in a repo with no commits yet, which is still worth snapshotting.
  if (status === null) return undefined
  return {
    head: (head ?? "").trim(),
    status: status.split("\n").filter((line) => line.trim()),
  }
}

/**
 * `git diff --stat` from the commit the returning agent last saw to the
 * working tree now — the one view that spans commits *and* uncommitted edits.
 * Null when there is no usable head to diff from.
 */
export async function readDiffStat(
  cwd: string | undefined,
  fromHead: string | undefined
): Promise<string[] | null> {
  const folder = cwd?.trim()
  const head = fromHead?.trim()
  // A commit id and nothing else ever reaches the command line.
  if (!folder || !head || !/^[0-9a-f]{7,64}$/i.test(head)) return null
  const out = await git(["diff", "--stat", head, "--"], folder)
  if (out === null) return null
  const rows = out.split("\n").filter((line) => line.trim())
  // The trailing " 3 files changed, 12 insertions(+)" summary repeats what the
  // rows already say and reads as another file when bulleted.
  if (rows.length > 0 && /files? changed/.test(rows[rows.length - 1])) rows.pop()
  return rows
}

async function git(args: string[], cwd: string): Promise<string | null> {
  const binary = await resolveGit()
  if (!binary) return null
  return new Promise((resolve) => {
    execFile(
      binary,
      ["--no-optional-locks", ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT,
        windowsHide: true,
        // A prompt for credentials or a pager would hang out the whole budget.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
      },
      (error, stdout) => resolve(error ? null : stdout)
    )
  })
}
