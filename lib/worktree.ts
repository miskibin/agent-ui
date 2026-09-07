import "server-only"

import { access, mkdir } from "node:fs/promises"
import path from "node:path"

import { runGit } from "@/lib/git-exec"
import { parsePorcelainV2Z } from "@/lib/git-status"
import {
  resolveAvailableBranchName,
  resolveAutoFeatureBranchName,
  sanitizeBranchFragment,
} from "@/lib/git-naming"
import { dataDir } from "@/lib/settings/server"

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * Git worktrees, so several agents can work on one repository at once.
 *
 * A chat's `cwd` is the only thing that decides where its agent runs, which
 * makes a worktree the whole feature: a second checkout of the same repo, on
 * its own branch, in its own folder. Two chats then edit the same project
 * without editing the same files, and neither has to stash or wait.
 *
 * Three things here are worth knowing before changing any of it:
 *
 * - **The worktrees the app makes live under its own data directory**
 *   (`$AGENT_UI_DIR/worktrees/<repo>/<branch>`), never beside the user's
 *   checkout. It is the app's litter to clean up, and putting it inside the
 *   repository's parent folder is how a `find`, a build script or a second
 *   worktree of the same name finds a surprise.
 * - **`branch.<name>.gh-merge-base` is recorded at creation.** It is what
 *   makes "ahead/behind what?" answerable for a branch with no upstream — the
 *   sidebar's counts, this file's own `unpushed`, and `gh pr create` all read
 *   it. A worktree created without it produces a branch that looks like it has
 *   diverged from nothing.
 * - **Removal is idempotent.** A worktree folder the user deleted by hand, a
 *   `git worktree prune` run in a terminal, two chats sharing one worktree —
 *   all of them end with "already gone", and that is a success, not an error.
 *
 * Every git call goes through `lib/git-exec`, which puts `--literal-pathspecs`
 * in front of it and never lets a prompt block on a human.
 */

/** A worktree add copies a whole tree; a cold monorepo needs the room. */
const ADD_TIMEOUT_MS = 300_000
/** Removal is filesystem-bound and can take minutes on a large `node_modules`. */
const REMOVE_TIMEOUT_MS = 300_000
/** Submodules can reach the network on a first-ever checkout. */
const SUBMODULE_TIMEOUT_MS = 300_000
const LIST_TIMEOUT_MS = 15_000
const QUICK_TIMEOUT_MS = 5_000

/** Where every worktree this app creates lives. */
export function worktreesRoot() {
  return path.join(dataDir(), "worktrees")
}

/** The folder name a repository's worktrees are grouped under. */
export function repoSlug(repoRoot: string) {
  const name = path.basename(path.resolve(repoRoot))
  return sanitizeBranchFragment(name).replace(/\//g, "-")
}

/** The default folder for `branch` of `repoRoot` — one level per repository. */
export function worktreePathFor(repoRoot: string, branch: string) {
  const leaf = sanitizeBranchFragment(branch).replace(/\//g, "-")
  return path.join(worktreesRoot(), repoSlug(repoRoot), leaf)
}

async function exists(target: string) {
  return access(target).then(
    () => true,
    () => false
  )
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export type RepoRoot = {
  /** The worktree holding `cwd`; a linked worktree is its own root. */
  root: string
  /** The checkout that owns the shared git directory. */
  mainRoot: string
  /** `root` is a linked worktree of `mainRoot` rather than the main checkout. */
  linked: boolean
}

/**
 * The repository a folder belongs to, and whether that folder is the main
 * checkout or one of its worktrees.
 *
 * `--git-common-dir` is what tells the two apart: a linked worktree's own git
 * directory is `<main>/.git/worktrees/<name>`, while the *common* one stays
 * `<main>/.git`. Comparing them is cheaper and more honest than looking for a
 * `.git` file rather than a directory.
 */
export async function repoRootOf(cwd: string): Promise<RepoRoot | null> {
  const top = await runGit(["rev-parse", "--show-toplevel"], {
    cwd,
    timeoutMs: QUICK_TIMEOUT_MS,
  })
  const root = top.ok ? top.stdout.trim() : ""
  if (!root) return null

  const [gitDir, commonDir] = await Promise.all([
    runGit(["rev-parse", "--absolute-git-dir"], { cwd, timeoutMs: QUICK_TIMEOUT_MS }),
    runGit(["rev-parse", "--git-common-dir"], { cwd, timeoutMs: QUICK_TIMEOUT_MS }),
  ])
  const common = commonDir.ok ? commonDir.stdout.trim() : ""
  if (!common) return { root, mainRoot: root, linked: false }
  const commonPath = path.isAbsolute(common) ? common : path.resolve(cwd, common)
  // `<main>/.git` → the main checkout is its parent; a bare repository has no
  // parent worth naming, so the git directory itself is the root.
  const mainRoot =
    path.basename(commonPath) === ".git" ? path.dirname(commonPath) : commonPath
  const own = gitDir.ok ? gitDir.stdout.trim() : ""
  const linked = own ? path.resolve(own) !== path.resolve(commonPath) : false
  return { root, mainRoot, linked }
}

export type WorktreeEntry = {
  path: string
  /** Short branch name — `refs/heads/` stripped. Absent when detached. */
  branch?: string
  head?: string
  bare: boolean
  detached: boolean
  locked: boolean
  /** The first entry `git` lists is the main checkout. */
  main: boolean
}

/**
 * `git worktree list --porcelain` in either separator form.
 *
 * The `-z` form (git ≥ 2.36) is asked for first because a path is raw bytes in
 * it; the newline form C-quotes anything unusual, so it is only the fallback.
 * Both share one shape — attribute lines, a blank record between worktrees —
 * so one parser reads either. A **prunable** entry is skipped: its folder is
 * gone and git is only still holding the registration.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  let prunable = false

  const flush = () => {
    if (current && !prunable) entries.push({ ...current, main: entries.length === 0 })
    current = null
    prunable = false
  }

  for (const field of stdout.split(/\0|\n/)) {
    if (field === "") {
      flush()
      continue
    }
    if (field.startsWith("worktree ")) {
      flush()
      current = {
        path: field.slice("worktree ".length),
        bare: false,
        detached: false,
        locked: false,
        main: false,
      }
      continue
    }
    if (!current) continue
    if (field.startsWith("branch refs/heads/")) {
      current.branch = field.slice("branch refs/heads/".length)
    } else if (field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length)
    } else if (field === "bare") {
      current.bare = true
    } else if (field === "detached") {
      current.detached = true
    } else if (field === "locked" || field.startsWith("locked ")) {
      current.locked = true
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      prunable = true
    }
  }
  flush()
  return entries
}

/** Every registered worktree of `repo`, the stale registrations dropped. */
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const listed = await runGit(["worktree", "list", "--porcelain", "-z"], {
    cwd: repo,
    timeoutMs: LIST_TIMEOUT_MS,
  })
  if (listed.ok) return parseWorktreeList(listed.stdout)
  // git < 2.36 has no `-z` for this subcommand and exits 129 on the flag.
  const plain = await runGit(["worktree", "list", "--porcelain"], {
    cwd: repo,
    timeoutMs: LIST_TIMEOUT_MS,
  })
  return plain.ok ? parseWorktreeList(plain.stdout) : []
}

/** Local branch names, short form — what a new name must not collide with. */
export async function localBranchNames(repoRoot: string): Promise<string[]> {
  const listed = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd: repoRoot, timeoutMs: LIST_TIMEOUT_MS }
  )
  if (!listed.ok) return []
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

async function refExists(repoRoot: string, ref: string) {
  const found = await runGit(["show-ref", "--verify", "--quiet", ref], {
    cwd: repoRoot,
    timeoutMs: QUICK_TIMEOUT_MS,
  })
  return found.ok
}

async function hasCommits(repoRoot: string) {
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    cwd: repoRoot,
    timeoutMs: QUICK_TIMEOUT_MS,
  })
  return head.ok && head.stdout.trim().length > 0
}

async function remoteNames(repoRoot: string): Promise<string[]> {
  const listed = await runGit(["remote"], { cwd: repoRoot, timeoutMs: QUICK_TIMEOUT_MS })
  if (!listed.ok) return []
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    // Longest first: `origin/feature` must not be read as remote `o`.
    .sort((left, right) => right.length - left.length)
}

/** `origin/main` → `main`, but only when `origin` really is a remote here. */
export function stripRemotePrefix(ref: string, remotes: readonly string[]) {
  for (const remote of remotes) {
    if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1)
  }
  return ref
}

/**
 * The repository's default branch, as far as it can be known without asking
 * the network: what `origin/HEAD` points at, else `main` or `master` if either
 * exists locally, else whatever HEAD is on now.
 */
export async function defaultBranchName(repoRoot: string): Promise<string | null> {
  const originHead = await runGit(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { cwd: repoRoot, timeoutMs: QUICK_TIMEOUT_MS }
  )
  const pointed = originHead.ok ? originHead.stdout.trim() : ""
  if (pointed.startsWith("origin/")) return pointed.slice("origin/".length)

  for (const candidate of ["main", "master"]) {
    if (await refExists(repoRoot, `refs/heads/${candidate}`)) return candidate
  }
  const head = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    timeoutMs: QUICK_TIMEOUT_MS,
  })
  const branch = head.ok ? head.stdout.trim() : ""
  return branch && branch !== "HEAD" ? branch : null
}

export type BaseRef = {
  /** What `git worktree add` is told to branch from. */
  ref: string
  /** The *branch* that ref names, for `gh-merge-base`. */
  branch?: string
}

/**
 * What a new worktree starts from.
 *
 * With `startFromOrigin` the remote-tracking ref wins when it is already in
 * the object store — a new branch then starts from what the team has, not from
 * whatever the user's local `main` was last left at. Nothing is fetched: this
 * runs while somebody waits for a folder to open, and a network call there is
 * a hang, not a feature.
 */
export async function resolveBaseRef(
  repoRoot: string,
  options: { baseRef?: string; startFromOrigin?: boolean } = {}
): Promise<BaseRef> {
  const explicit = options.baseRef?.trim()
  if (explicit) {
    return { ref: explicit, branch: stripRemotePrefix(explicit, await remoteNames(repoRoot)) }
  }
  const preferred = await defaultBranchName(repoRoot)
  if (!preferred) return { ref: "HEAD" }
  if (
    options.startFromOrigin !== false &&
    (await refExists(repoRoot, `refs/remotes/origin/${preferred}`))
  ) {
    return { ref: `origin/${preferred}`, branch: preferred }
  }
  if (await refExists(repoRoot, `refs/heads/${preferred}`)) {
    return { ref: preferred, branch: preferred }
  }
  return { ref: "HEAD", branch: preferred }
}

/* -------------------------------------------------------------------------- */
/* Creating                                                                    */
/* -------------------------------------------------------------------------- */

export type CreateWorktreeInput = {
  /** Any folder inside the repository; the main checkout is resolved from it. */
  repoRoot: string
  /** Branch to create. Derived from `title` when absent. */
  branch?: string
  /** Chat title, used to name the branch when none was given. */
  title?: string
  /** What to branch from. Resolved by `resolveBaseRef` when absent. */
  baseRef?: string
  /** Where to put it. Defaults to `worktreePathFor`. */
  root?: string
  /** Prefer `origin/<default>` over the local default branch. Default on. */
  startFromOrigin?: boolean
}

export type WorktreeRef = {
  root: string
  branch: string
  baseBranch?: string
  repoRoot: string
}

export type CreateWorktreeResult =
  | ({ ok: true } & WorktreeRef)
  | { ok: false; error: string; status: number }

/** A folder that does not exist yet, starting from `preferred`. */
async function freeDirectory(preferred: string) {
  if (!(await exists(preferred))) return preferred
  for (let suffix = 2; suffix <= 100; suffix += 1) {
    const candidate = `${preferred}-${suffix}`
    if (!(await exists(candidate))) return candidate
  }
  return `${preferred}-${Date.now().toString(36)}`
}

/**
 * A new worktree of `repoRoot` on a new branch.
 *
 * The branch name is resolved against the branches that already exist, so
 * three chats named "fix the parser" produce `feature/fix-the-parser`,
 * `-2` and `-3` rather than two failures.
 */
export async function createWorktree(
  input: CreateWorktreeInput
): Promise<CreateWorktreeResult> {
  const repo = await repoRootOf(input.repoRoot)
  if (!repo) {
    return { ok: false, error: "That folder is not a git repository", status: 409 }
  }
  // Worktrees are always added from the checkout that owns the git directory:
  // adding one from inside another worktree works, but records paths relative
  // to a folder that may itself be removed later.
  const repoRoot = repo.mainRoot
  if (!(await hasCommits(repoRoot))) {
    return {
      ok: false,
      error: "This repository has no commits yet, so there is nothing to branch from",
      status: 409,
    }
  }

  const desired = input.branch?.trim()
    ? input.branch.trim()
    : resolveAutoFeatureBranchName(input.title)
  const branch = resolveAvailableBranchName(desired, await localBranchNames(repoRoot))
  const base = await resolveBaseRef(repoRoot, {
    baseRef: input.baseRef,
    startFromOrigin: input.startFromOrigin,
  })

  const preferred = input.root?.trim() || worktreePathFor(repoRoot, branch)
  const root = await freeDirectory(path.resolve(preferred))
  await mkdir(path.dirname(root), { recursive: true })

  const added = await runGit(
    ["worktree", "add", "-b", branch, root, base.ref],
    { cwd: repoRoot, timeoutMs: ADD_TIMEOUT_MS, readOnlyConfig: false }
  )
  if (!added.ok) {
    return {
      ok: false,
      // The one place a git message is worth showing: "invalid reference",
      // "already checked out" and "permission denied" are all things the user
      // can act on, and none of them carry a credential.
      error: firstLine(added.stderr) || "git worktree add failed",
      status: 500,
    }
  }

  // What "ahead" and "behind" mean for a branch with no upstream, and what
  // `gh pr create` opens the pull request against.
  if (base.branch) {
    await runGit(["config", `branch.${branch}.gh-merge-base`, base.branch], {
      cwd: repoRoot,
      timeoutMs: QUICK_TIMEOUT_MS,
      readOnlyConfig: false,
    })
  }

  await initSubmodules(root)

  return { ok: true, root, branch, baseBranch: base.branch, repoRoot }
}

/**
 * `git worktree add` leaves submodules empty, so a repo that keeps tooling,
 * skills or source in one gets a checkout quietly missing them. Best effort in
 * the strongest sense: the objects are usually already in the parent's
 * `.git/modules`, but a first-ever checkout needs the network — and a worktree
 * that exists with empty submodules is still far better than no worktree.
 */
async function initSubmodules(worktreeRoot: string) {
  if (!(await exists(path.join(worktreeRoot, ".gitmodules")))) return
  const updated = await runGit(["submodule", "update", "--init", "--recursive"], {
    cwd: worktreeRoot,
    timeoutMs: SUBMODULE_TIMEOUT_MS,
    readOnlyConfig: false,
  })
  if (updated.ok) return
  // Bounded diagnostics only: git's stderr on a submodule can carry a remote
  // URL with a token in it.
  console.warn(
    `[worktree] submodule checkout failed in ${worktreeRoot} ` +
      `(${updated.kind ?? "failed"}, exit ${updated.exitCode ?? "none"}); ` +
      "submodule paths are empty"
  )
}

/* -------------------------------------------------------------------------- */
/* Status and removal                                                          */
/* -------------------------------------------------------------------------- */

export type WorktreeStatus = {
  /** The worktree still exists on disk and git still answers for it. */
  exists: boolean
  branch: string
  /** Tracked-and-changed plus untracked files. */
  dirty: number
  /** Commits the upstream — or, with none, the recorded base — does not have. */
  unpushed: number
  hasUpstream: boolean
  baseBranch?: string
}

const EMPTY_STATUS: WorktreeStatus = {
  exists: false,
  branch: "",
  dirty: 0,
  unpushed: 0,
  hasUpstream: false,
}

/**
 * What removing this worktree would throw away — the two numbers the
 * confirmation needs and nothing else.
 *
 * Every failure degrades to zero rather than to an error: the caller is a
 * confirmation dialog, and a dialog that cannot say "3 uncommitted files"
 * should still be able to say "remove it?".
 */
export async function worktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
  if (!(await exists(worktreePath))) return EMPTY_STATUS
  const status = await runGit(["status", "--porcelain=2", "--branch", "-z"], {
    cwd: worktreePath,
    timeoutMs: LIST_TIMEOUT_MS,
  })
  if (!status.ok) return EMPTY_STATUS
  const parsed = parsePorcelainV2Z(status.stdout)
  const result: WorktreeStatus = {
    exists: true,
    branch: parsed.branch,
    dirty: parsed.changed.length,
    unpushed: parsed.upstream ? parsed.ahead : 0,
    hasUpstream: Boolean(parsed.upstream),
  }
  if (result.hasUpstream || !parsed.branch) return result

  // No upstream: the branch has never been pushed, so "unpushed" is measured
  // against the base it was cut from — which is exactly what the
  // `gh-merge-base` recorded at creation is for.
  const configured = await runGit(
    ["config", "--get", `branch.${parsed.branch}.gh-merge-base`],
    { cwd: worktreePath, timeoutMs: QUICK_TIMEOUT_MS }
  )
  const baseBranch = configured.ok ? configured.stdout.trim() : ""
  if (!baseBranch) return result
  result.baseBranch = baseBranch
  for (const candidate of [`origin/${baseBranch}`, baseBranch]) {
    const counted = await runGit(["rev-list", "--count", `${candidate}..HEAD`], {
      cwd: worktreePath,
      timeoutMs: LIST_TIMEOUT_MS,
    })
    if (!counted.ok) continue
    const count = Number(counted.stdout.trim())
    if (Number.isFinite(count)) {
      result.unpushed = count
      break
    }
  }
  return result
}

/** git's two ways of saying "there is no such worktree here". */
function isMissingWorktreeStderr(stderr: string) {
  const normalized = stderr.toLowerCase()
  return (
    normalized.includes("is not a working tree") ||
    normalized.includes("cannot remove working tree")
  )
}

function firstLine(text: string) {
  return text.trim().split("\n")[0]?.trim() ?? ""
}

export type RemoveWorktreeOptions = {
  /** Remove it even with uncommitted changes in it. */
  force?: boolean
  /** Delete this branch too, once the worktree is gone. Best effort. */
  branch?: string
}

export type RemoveWorktreeResult =
  | { ok: true; removed: boolean; branchDeleted: boolean }
  | { ok: false; error: string; status: number }

/**
 * Removes a worktree, idempotently.
 *
 * Two chats can point at one worktree, a user can delete the folder in Finder,
 * and `git worktree prune` can run in a terminal — so "it is not there" is the
 * expected outcome as often as the successful removal is. When git says the
 * path is not a working tree *and* the folder really is gone, the registration
 * is pruned so a later `worktree add` at the same path is not blocked, and the
 * call reports success.
 *
 * Raw stderr never reaches the caller: it can carry a remote URL with a token
 * in it, and this message ends up in a toast.
 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  const target = path.resolve(worktreePath)
  const args = ["worktree", "remove", ...(options.force ? ["--force"] : []), target]
  const removed = await runGit(args, {
    cwd: repoRoot,
    timeoutMs: REMOVE_TIMEOUT_MS,
    readOnlyConfig: false,
  })

  let gone = removed.ok
  if (!removed.ok) {
    const alreadyGone = isMissingWorktreeStderr(removed.stderr) && !(await exists(target))
    if (!alreadyGone) {
      console.warn(
        `[worktree] git worktree remove exited ${removed.exitCode ?? "none"} ` +
          `for ${target} (${removed.kind ?? "failed"}, stderr ${removed.stderr.length}b)`
      )
      return {
        ok: false,
        error: removed.stderr.toLowerCase().includes("contains modified or untracked")
          ? "That worktree has uncommitted changes"
          : "Could not remove the worktree",
        status: 409,
      }
    }
    gone = true
  }

  // Whether it was removed or found missing, a stale registration left behind
  // would block the next `worktree add` at the same path.
  await runGit(["worktree", "prune"], {
    cwd: repoRoot,
    timeoutMs: LIST_TIMEOUT_MS,
    readOnlyConfig: false,
  })

  let branchDeleted = false
  const branch = options.branch?.trim()
  if (gone && branch) {
    // `-D`, not `-d`: the branch is unmerged by definition, and the user has
    // already been told what removing it throws away.
    const deleted = await runGit(["branch", "-D", "--", branch], {
      cwd: repoRoot,
      timeoutMs: QUICK_TIMEOUT_MS,
      readOnlyConfig: false,
    })
    branchDeleted = deleted.ok
  }

  return { ok: true, removed: gone, branchDeleted }
}
