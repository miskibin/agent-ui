import "server-only"

import { MAX_GIT_OUTPUT, runGit } from "@/lib/git-exec"

/**
 * The working tree's diff, one entry per file — what the changes panel reads.
 *
 * `git status` already says *which* files changed; this says what changed in
 * them. Split per file rather than handed over as one patch because the panel
 * draws one `DiffView` per file, and a single blob would have to be re-split in
 * the browser by the same rules git already applied.
 *
 * Two things a naive `git diff` would miss, and both are the common case in a
 * chat: a file the agent *created* is untracked, so it is absent from the diff
 * entirely, and a file it deleted has no worktree side. `--no-ext-diff` keeps a
 * user's configured difftool out of it, and `--no-color` keeps escape codes out
 * of text that goes into a browser.
 */

/** `git diff HEAD` timeout — a big worktree is still one process. */
const DIFF_TIMEOUT_MS = 10_000

/**
 * How much of one file's patch is worth sending. A generated lockfile is
 * megabytes of diff nobody reads, and the panel says so rather than freezing
 * the tab trying to highlight it.
 */
export const MAX_FILE_PATCH_CHARS = 200_000

export type ChangedFilePatch = {
  path: string
  /** `A` added, `M` modified, `D` deleted, `?` untracked — git's own letters. */
  status: string
  insertions: number
  deletions: number
  /** Unified patch for this file alone, or "" when there is none to show. */
  patch: string
  /** The patch hit {@link MAX_FILE_PATCH_CHARS} and is not the whole story. */
  truncated?: boolean
  /** Git calls it binary; there is no text diff to draw. */
  binary?: boolean
}

/**
 * Splits `git diff`'s output on the `diff --git` lines that start each file.
 *
 * The path comes from the `+++ b/<path>` line rather than from `diff --git`,
 * because the latter is ambiguous for a path containing " b/" while the former
 * is one field. A deletion has no `+++` side, so it falls back to `--- a/`.
 */
function splitPatches(output: string): Map<string, string> {
  const patches = new Map<string, string>()
  if (!output.trim()) return patches
  const chunks = output.split(/^diff --git /m).slice(1)
  for (const chunk of chunks) {
    const body = `diff --git ${chunk}`
    const to = /^\+\+\+ b\/(.+)$/m.exec(body)?.[1]
    const from = /^--- a\/(.+)$/m.exec(body)?.[1]
    const path = to && to !== "/dev/null" ? to : from
    if (path && path !== "/dev/null") patches.set(path, body)
  }
  return patches
}

function cap(patch: string): { patch: string; truncated?: boolean } {
  if (patch.length <= MAX_FILE_PATCH_CHARS) return { patch }
  return { patch: patch.slice(0, MAX_FILE_PATCH_CHARS), truncated: true }
}

/** `path` as git's porcelain writes it — quoted when it holds anything odd. */
function unquote(path: string) {
  if (!path.startsWith('"')) return path
  try {
    return JSON.parse(path) as string
  } catch {
    return path.slice(1, -1)
  }
}

/**
 * Every changed file in `cwd`, with its patch.
 *
 * Tracked changes come from one `git diff HEAD`; untracked files are listed
 * separately and diffed against `/dev/null` with `--no-index`, which is how git
 * itself renders a new file. A repository with no commits yet has no `HEAD` to
 * diff against, so everything in it is treated as new.
 */
export async function changedFiles(cwd: string): Promise<ChangedFilePatch[]> {
  const options = { cwd, timeoutMs: DIFF_TIMEOUT_MS, maxBuffer: MAX_GIT_OUTPUT }
  const [statusRun, diffRun, numstatRun] = await Promise.all([
    // `--untracked-files=all`, because the default collapses a new directory
    // to one `?? sub/` entry. A folder is not a diff: it would take a row in
    // the panel, have no patch behind it, and say nothing about the files the
    // agent actually wrote inside it.
    runGit(["status", "--porcelain", "--untracked-files=all"], options),
    runGit(["diff", "--no-ext-diff", "--no-color", "HEAD"], options),
    runGit(["diff", "--no-ext-diff", "--numstat", "HEAD"], options),
  ])
  if (!statusRun.ok) return []

  const patches = splitPatches(diffRun.ok ? diffRun.stdout : "")
  const counts = new Map<string, { insertions: number; deletions: number }>()
  if (numstatRun.ok) {
    for (const line of numstatRun.stdout.split("\n")) {
      const [added, removed, ...rest] = line.split("\t")
      const path = rest.join("\t").trim()
      if (!path) continue
      counts.set(unquote(path), {
        insertions: Number(added) || 0,
        deletions: Number(removed) || 0,
      })
    }
  }

  const files: ChangedFilePatch[] = []
  const untracked: string[] = []
  for (const line of statusRun.stdout.split("\n")) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const path = unquote(line.slice(3).split(" -> ").pop()!.trim())
    if (!path) continue
    if (code === "??") {
      untracked.push(path)
      continue
    }
    const count = counts.get(path) ?? { insertions: 0, deletions: 0 }
    const patch = patches.get(path) ?? ""
    files.push({
      path,
      status: code.trim().slice(0, 1) || "M",
      ...count,
      ...cap(patch),
      binary: /^Binary files /m.test(patch) || undefined,
    })
  }

  // A file the agent just wrote is untracked, and untracked is exactly the
  // state a chat's changes are usually in. `--no-index` against /dev/null is
  // how git renders a new file, and its exit code is 1 for "they differ".
  const news = await Promise.all(
    untracked.map(async (path) => {
      const run = await runGit(
        ["diff", "--no-ext-diff", "--no-color", "--no-index", "--", "/dev/null", path],
        options
      )
      const patch = run.stdout ?? ""
      const added = patch.split("\n").filter((l) => l.startsWith("+")).length
      return {
        path,
        status: "A",
        insertions: Math.max(0, added - 1),
        deletions: 0,
        ...cap(patch),
        binary: /^Binary files /m.test(patch) || undefined,
      } satisfies ChangedFilePatch
    })
  )

  return [...files, ...news].sort((a, b) => a.path.localeCompare(b.path))
}
