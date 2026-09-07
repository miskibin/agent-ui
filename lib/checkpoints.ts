import "server-only"

import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import path from "node:path"

import {
  parseNumstatZ,
  runGit,
  type NumstatFile,
} from "@/lib/git-exec"

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * What the worktree looked like before and after each turn — the app's undo
 * for an agent.
 *
 * A checkpoint is a real commit, and reachable from nothing: the tree is built
 * in a **temporary index** (`GIT_INDEX_FILE` under the repo's own
 * `--git-common-dir`), written with `write-tree`, committed *parentless* with
 * `commit-tree`, and pointed at by a ref under `refs/agent-ui/checkpoints/`.
 * Which means, in order of how much it matters:
 *
 * - **Nothing the user staged is touched.** `git add -A` normally rewrites
 *   `.git/index`; here it rewrites a scratch file that is deleted in the
 *   `finally`. A capture after every turn is otherwise unusable — it would
 *   silently stage the agent's work over whatever the user had prepared.
 * - **Nothing appears in the history.** A parentless commit under a private
 *   ref namespace is invisible to `git log`, `git status` and every branch;
 *   `git gc` will not collect it, because the ref keeps it alive.
 * - **Untracked files are included.** `add -A -- .` is what makes "the agent
 *   created six files and I want them gone" a thing this can undo, and it is
 *   also why restore has to `clean -fd` rather than just `restore`.
 *
 * Restore is the mirror: `restore --source <commit> --worktree --staged -- .`
 * puts every tracked file back, `clean -fd -- .` removes what the checkpoint
 * did not have, and `reset --quiet -- .` returns the index to HEAD so the user
 * is not left with the whole tree staged.
 *
 * **This is a destructive operation on the user's disk.** Every path argument
 * here is the literal `.`, and every command goes through `lib/git-exec`,
 * which puts `--literal-pathspecs` in front of it — for the reason spelled out
 * in `app/api/git/revert`.
 *
 * On by default. There is no setting for it yet: `handoff.enabled` is the
 * closest analogue and lives in a schema this file does not own, so if one is
 * wanted, add `checkpoints.enabled` beside it and gate the two API routes on
 * it — nothing here holds state that would need migrating.
 */

/** Private namespace: not `refs/heads`, not `refs/tags`, not fetched or pushed. */
export const CHECKPOINT_REFS_PREFIX = "refs/agent-ui/checkpoints"

/** A capture reads and writes the whole tree; a cold monorepo needs the room. */
const CAPTURE_TIMEOUT_MS = 60_000
const DIFF_TIMEOUT_MS = 20_000
const QUICK_TIMEOUT_MS = 5_000

/** A numstat past this is not a diff anyone is reading; it is a broken read. */
const MAX_NUMSTAT_BYTES = 4 * 1024 * 1024
/** T3's cap, and the same reasoning: a patch bigger than this is a mistake. */
const MAX_PATCH_BYTES = 10_000_000

/** Never a real person: a checkpoint is not authored, it is taken. */
const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: "Agent UI",
  GIT_AUTHOR_EMAIL: "agent-ui@localhost",
  GIT_COMMITTER_NAME: "Agent UI",
  GIT_COMMITTER_EMAIL: "agent-ui@localhost",
} as const

export type CheckpointFile = NumstatFile

/**
 * Session ids are base64url-encoded into the ref rather than interpolated: a
 * ref name may not hold a space, a `~`, a `..` or a leading dot, and a session
 * id is not this file's to validate.
 */
export function checkpointRefsRoot(sessionId: string) {
  const encoded = Buffer.from(sessionId, "utf8").toString("base64url")
  return `${CHECKPOINT_REFS_PREFIX}/${encoded}`
}

/** The ref holding the worktree as it stood at the end of turn `turn`. */
export function checkpointRefFor(sessionId: string, turn: number) {
  return `${checkpointRefsRoot(sessionId)}/turn/${Math.max(0, Math.trunc(turn))}`
}

/** Is this folder inside a git worktree at all? Everything else is a no-op. */
export async function isGitWorktree(cwd: string) {
  const found = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeoutMs: QUICK_TIMEOUT_MS,
  })
  return found.ok && found.stdout.trim() === "true"
}

/** The commit a ref names, or null — `--verify --quiet` so a miss is silent. */
async function resolveCommit(cwd: string, ref: string) {
  const found = await runGit(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd, timeoutMs: QUICK_TIMEOUT_MS }
  )
  const commit = found.ok ? found.stdout.trim() : ""
  return commit || null
}

export async function hasCheckpointRef(cwd: string, ref: string) {
  return (await resolveCommit(cwd, ref)) !== null
}

/** Where the *shared* git directory is — a linked worktree's is not `.git`. */
async function gitCommonDir(cwd: string) {
  const found = await runGit(["rev-parse", "--git-common-dir"], {
    cwd,
    timeoutMs: QUICK_TIMEOUT_MS,
  })
  if (!found.ok) return null
  const dir = found.stdout.trim()
  if (!dir) return null
  return path.isAbsolute(dir) ? dir : path.resolve(cwd, dir)
}

export type CaptureResult =
  | { ok: true; ref: string; commit: string }
  | { ok: false; error: string }

/**
 * The worktree as it stands now, committed to `ref`.
 *
 * Ported from T3 Code's `captureCheckpoint`. The temp index is removed in a
 * `finally` whatever happens — a stray `agent-ui-checkpoint-index-*` in
 * `.git/` is litter, and one that survived a crash would be reused by nothing,
 * but it is still the user's repository.
 */
export async function captureCheckpoint(
  cwd: string,
  ref: string
): Promise<CaptureResult> {
  const commonDir = await gitCommonDir(cwd)
  if (!commonDir) return { ok: false, error: "Not a git repository" }
  const tempIndex = path.join(commonDir, `agent-ui-checkpoint-index-${randomUUID()}`)
  const env = {
    GIT_INDEX_FILE: tempIndex,
    ...CHECKPOINT_IDENTITY,
  }
  const git = (args: string[]) =>
    runGit(args, {
      cwd,
      timeoutMs: CAPTURE_TIMEOUT_MS,
      env,
      // A capture wants the repository's own configuration; the read-only
      // overrides exist for polls, and one of them (`core.fsmonitor=false`)
      // would make `add -A` walk a large repo the slow way.
      readOnlyConfig: false,
    })

  try {
    // Seed from HEAD so an unchanged file keeps its recorded stat and `add`
    // does not re-hash the entire tree. A repo with no commits has nothing to
    // seed from, which is fine: the index simply starts empty.
    if (await resolveCommit(cwd, "HEAD")) {
      const seeded = await git(["read-tree", "HEAD"])
      if (!seeded.ok) {
        return { ok: false, error: seeded.stderr.trim() || "git read-tree failed" }
      }
    }
    const added = await git(["add", "-A", "--", "."])
    if (!added.ok) {
      return { ok: false, error: added.stderr.trim() || "git add failed" }
    }
    const tree = await git(["write-tree"])
    const treeOid = tree.ok ? tree.stdout.trim() : ""
    if (!treeOid) {
      return { ok: false, error: tree.stderr.trim() || "git write-tree failed" }
    }
    const committed = await git([
      "commit-tree",
      treeOid,
      "-m",
      `agent-ui checkpoint ref=${ref}`,
    ])
    const commit = committed.ok ? committed.stdout.trim() : ""
    if (!commit) {
      return {
        ok: false,
        error: committed.stderr.trim() || "git commit-tree failed",
      }
    }
    const pointed = await git(["update-ref", ref, commit])
    if (!pointed.ok) {
      return { ok: false, error: pointed.stderr.trim() || "git update-ref failed" }
    }
    return { ok: true, ref, commit }
  } finally {
    await rm(tempIndex, { force: true }).catch(() => {
      /* the next capture mints its own name; this is litter, not a failure */
    })
  }
}

export type DiffResult =
  | { ok: true; files: CheckpointFile[] }
  | { ok: false; error: string }

/**
 * What changed between two checkpoints, as numstat rows.
 *
 * `-z`, so a rename is three records and a non-ASCII name arrives as its own
 * bytes (see `parseNumstatZ`). `--no-ext-diff --no-textconv` because a repo
 * may configure a diff driver that shells out, and a background read after
 * every turn must not run the user's programs. A truncated read is an **error**
 * rather than a short list: half a numstat looks exactly like a small change.
 */
export async function diffCheckpoints(
  cwd: string,
  fromRef: string,
  toRef: string
): Promise<DiffResult> {
  const from = await resolveCommit(cwd, fromRef)
  const to = await resolveCommit(cwd, toRef)
  if (!from || !to) return { ok: false, error: "That checkpoint is gone" }
  const diffed = await runGit(
    [
      "diff",
      "--numstat",
      "-z",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      from,
      to,
    ],
    { cwd, timeoutMs: DIFF_TIMEOUT_MS, maxBuffer: MAX_NUMSTAT_BYTES }
  )
  if (diffed.truncated) {
    return { ok: false, error: "That diff is too large to summarize" }
  }
  if (!diffed.ok) {
    return { ok: false, error: diffed.stderr.trim() || "git diff failed" }
  }
  return { ok: true, files: parseNumstatZ(diffed.stdout) }
}

export type PatchResult =
  | { ok: true; patch: string; truncated: boolean }
  | { ok: false; error: string }

/** The same two commits as a patch. Truncated rather than refused: a head of a huge diff is still readable. */
export async function patchCheckpoints(
  cwd: string,
  fromRef: string,
  toRef: string
): Promise<PatchResult> {
  const from = await resolveCommit(cwd, fromRef)
  const to = await resolveCommit(cwd, toRef)
  if (!from || !to) return { ok: false, error: "That checkpoint is gone" }
  const diffed = await runGit(
    [
      "diff",
      "--patch",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      from,
      to,
    ],
    { cwd, timeoutMs: DIFF_TIMEOUT_MS, maxBuffer: MAX_PATCH_BYTES }
  )
  if (!diffed.ok && !diffed.truncated) {
    return { ok: false, error: diffed.stderr.trim() || "git diff failed" }
  }
  return { ok: true, patch: diffed.stdout, truncated: diffed.truncated }
}

export type RestoreResult =
  | { ok: true; commit: string }
  | { ok: false; error: string }

/**
 * Put the worktree back the way `ref` remembers it.
 *
 * Three commands, in this order and none of them optional: `restore` rewrites
 * every file the checkpoint had, `clean -fd` deletes what it did not (the
 * files the agent created since), and `reset` unstages, because `restore
 * --staged` has just staged the entire tree.
 */
export async function restoreCheckpoint(
  cwd: string,
  ref: string
): Promise<RestoreResult> {
  const commit = await resolveCommit(cwd, ref)
  if (!commit) return { ok: false, error: "That checkpoint is gone" }
  const git = (args: string[]) =>
    runGit(args, { cwd, timeoutMs: CAPTURE_TIMEOUT_MS, readOnlyConfig: false })

  const restored = await git([
    "restore",
    "--source",
    commit,
    "--worktree",
    "--staged",
    "--",
    ".",
  ])
  if (!restored.ok) {
    return { ok: false, error: restored.stderr.trim() || "git restore failed" }
  }
  const cleaned = await git(["clean", "-fd", "--", "."])
  if (!cleaned.ok) {
    return { ok: false, error: cleaned.stderr.trim() || "git clean failed" }
  }
  // Nothing to reset *to* in a repo with no commits; the index is the tree.
  if (await resolveCommit(cwd, "HEAD")) {
    await git(["reset", "--quiet", "--", "."])
  }
  return { ok: true, commit }
}

/**
 * Every checkpoint this chat ever took, deleted.
 *
 * Called when the chat is: the commits are unreachable the moment their refs
 * are gone, and a deleted conversation must not leave the user's repository
 * pinning the worktrees it went through.
 */
export async function deleteCheckpointRefs(cwd: string, sessionId: string) {
  const root = checkpointRefsRoot(sessionId)
  // A pattern ending in "/" matches everything under that directory.
  const listed = await runGit(
    ["for-each-ref", "--format=%(refname)", `${root}/`],
    { cwd, timeoutMs: QUICK_TIMEOUT_MS }
  )
  if (!listed.ok) return 0
  const refs = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${root}/`))
  let deleted = 0
  for (const ref of refs) {
    const dropped = await runGit(["update-ref", "-d", ref], {
      cwd,
      timeoutMs: QUICK_TIMEOUT_MS,
      readOnlyConfig: false,
    })
    if (dropped.ok) deleted += 1
  }
  return deleted
}
