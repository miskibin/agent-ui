import "server-only"

import { access, constants } from "node:fs/promises"
import path from "node:path"

import {
  isTransientGitFailure,
  parseNumstatZ,
  runGh,
  runGit,
  type GitFailureKind,
  type NumstatFile,
} from "@/lib/git-exec"

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * One folder's git state for the sidebar: branch, ahead/behind, how many files
 * are dirty and by how many lines, and the pull request on the branch when
 * `gh` is around.
 *
 * Two halves, two caches, on purpose. The **local** half is `git status` and
 * `git diff` in a folder on this disk: cheap, and stale within a second of the
 * agent writing a file, so it is cached for exactly that long. The **remote**
 * half is `gh`, which is a network call to GitHub — cached for a minute on
 * success and backed off exponentially (20s → 15min, per folder) on failure,
 * because a rate-limited poller that retries *faster* than a healthy one turns
 * one 429 into sustained pressure.
 *
 * The other rule that runs through this file: **a failure is not an answer**.
 * "Not a git repository" is a fact about the folder and is cached like any
 * other. A timeout, a held index lock or a broken submodule is a fact about
 * this second, and the sidebar keeps its last good badge instead of blinking
 * out — that is what `stale` says.
 */

const GIT_TIMEOUT_MS = 3_000
const GH_TIMEOUT_MS = 6_000

/** The worktree moves under the agent's hands; a second is already generous. */
const LOCAL_TTL_MS = 1_000
/** A PR does not appear in the second between two sidebar polls. */
const PR_TTL_MS = 60_000
const PR_FAILURE_BASE_TTL_MS = 20_000
const PR_FAILURE_MAX_TTL_MS = 15 * 60_000
/** `origin/HEAD` is set once at clone time and then essentially never. */
const DEFAULT_BRANCH_TTL_MS = 5 * 60_000

/** One entry per folder ever polled would grow for the life of the server. */
const MAX_CACHED = 64

export type PullRequestState = "OPEN" | "MERGED" | "CLOSED"

/** One row of `git diff --numstat`. */
export type { NumstatFile as GitStatusFile } from "@/lib/git-exec"

export type GitStatus = {
  isGitRepo: boolean
  branch: string
  ahead: number
  behind: number
  /** Modified, added, deleted and untracked entries in `git status`. */
  dirty: number
  pr?: {
    number: number
    url: string
    state: PullRequestState
    title: string
    isDraft?: boolean
    headRefName?: string
    baseRefName?: string
  }
  /* --- Added since; every consumer may ignore all of them. --------------- */
  /** The branch tracks a remote one. When false, `ahead` counts from `aheadOfDefault`. */
  hasUpstream?: boolean
  /** Commits on this branch that the repo's default branch does not have. */
  aheadOfDefault?: number
  /** `git diff HEAD --numstat`, summed. */
  insertions?: number
  deletions?: number
  /** Per-file diffstat, sorted by path. Untracked files appear with 0/0. */
  files?: NumstatFile[]
  /**
   * The read failed transiently and this is the last thing that worked (or,
   * with nothing to fall back on, nothing at all). Never set on a good read.
   */
  stale?: boolean
}

const EMPTY: GitStatus = {
  isGitRepo: false,
  branch: "",
  ahead: 0,
  behind: 0,
  dirty: 0,
}

type LocalStatus = Omit<GitStatus, "pr" | "stale">

type LocalResult =
  | { ok: true; status: LocalStatus }
  | { ok: false; kind: GitFailureKind }

/* -------------------------------------------------------------------------- */
/* Parsers — pure, and exported so `tests/git-status.test.ts` can reach them.  */
/* -------------------------------------------------------------------------- */

/** The path after `count` space-separated fields, spaces in it intact. */
function pathAfterFields(record: string, count: number) {
  let index = 0
  for (let field = 0; field < count; field += 1) {
    const next = record.indexOf(" ", index)
    if (next < 0) return ""
    index = next + 1
  }
  return record.slice(index)
}

export type PorcelainStatus = {
  branch: string
  upstream: string
  ahead: number
  behind: number
  /** Tracked-and-changed plus untracked; ignored entries never count. */
  changed: string[]
}

/**
 * `git status --porcelain=2 --branch -z` → the branch header and the paths.
 *
 * `-z` for the same reason as the numstat: NUL-separated records, raw bytes,
 * and a rename's original path in its own record rather than jammed into the
 * entry with an ` -> ` nobody can escape out of a filename.
 */
export function parsePorcelainV2Z(stdout: string): PorcelainStatus {
  const records = stdout.split("\0")
  const result: PorcelainStatus = {
    branch: "",
    upstream: "",
    ahead: 0,
    behind: 0,
    changed: [],
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length).trim()
      // "(detached)" — a head with no branch name is no branch name.
      result.branch = value.startsWith("(") ? "" : value
      continue
    }
    if (record.startsWith("# branch.upstream ")) {
      result.upstream = record.slice("# branch.upstream ".length).trim()
      continue
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^\+(\d+)\s+-(\d+)$/.exec(
        record.slice("# branch.ab ".length).trim()
      )
      if (match) {
        result.ahead = Number(match[1])
        result.behind = Number(match[2])
      }
      continue
    }
    if (record.startsWith("#")) continue
    // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
    if (record.startsWith("1 ")) {
      const value = pathAfterFields(record, 8)
      if (value) result.changed.push(value)
      continue
    }
    // `2 …<X><score> <path>`, with the original path in the *next* record.
    if (record.startsWith("2 ")) {
      const value = pathAfterFields(record, 9)
      if (value) result.changed.push(value)
      index += 1
      continue
    }
    // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
    if (record.startsWith("u ")) {
      const value = pathAfterFields(record, 10)
      if (value) result.changed.push(value)
      continue
    }
    // `? <path>` untracked. `! <path>` is ignored, and is not "dirty".
    if (record.startsWith("? ")) {
      const value = record.slice(2)
      if (value) result.changed.push(value)
    }
  }
  return result
}

/** `gh pr list --json …` output → the first entry this app can use. */
export function parsePullRequests(raw: string, branch: string): GitStatus["pr"] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  // Per element, tolerantly: a `gh` a version or two off adds and drops fields,
  // and one unreadable entry must never cost the badge the readable ones.
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue
    const item = entry as Record<string, unknown>
    if (typeof item.number !== "number" || typeof item.url !== "string") continue
    const head = typeof item.headRefName === "string" ? item.headRefName : ""
    if (branch && head && head !== branch) continue
    const state = typeof item.state === "string" ? item.state.toUpperCase() : "OPEN"
    return {
      number: item.number,
      url: item.url,
      state:
        state === "MERGED" || state === "CLOSED"
          ? (state as PullRequestState)
          : "OPEN",
      title: typeof item.title === "string" ? item.title : "",
      ...(item.isDraft === true ? { isDraft: true } : null),
      ...(head ? { headRefName: head } : null),
      ...(typeof item.baseRefName === "string"
        ? { baseRefName: item.baseRefName }
        : null),
    }
  }
  return undefined
}

/* -------------------------------------------------------------------------- */
/* The local half                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `index.lock` exists → do not read.
 *
 * From T3 Code's `readStatusDetailsLocal`. `git status` succeeds while the
 * index is locked, but it cannot write back what it computed, so on a repo
 * with LFS (or any other clean filter) every poll re-runs the filter over
 * every file, uncached. The lock is somebody else's write in flight; a moment
 * later there is a real answer to be had.
 */
async function indexLocked(cwd: string) {
  const found = await runGit(["rev-parse", "--git-path", "index"], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (!found.ok) return false
  const indexPath = found.stdout.trim()
  if (!indexPath) return false
  const lock = `${path.resolve(cwd, indexPath)}.lock`
  return access(lock, constants.F_OK).then(
    () => true,
    () => false
  )
}

const defaultBranches = new Map<string, { at: number; value: string }>()

/** `origin/HEAD` → the repo's default branch, or "". */
async function defaultBranch(cwd: string) {
  const hit = defaultBranches.get(cwd)
  if (hit && Date.now() - hit.at < DEFAULT_BRANCH_TTL_MS) return hit.value
  const found = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  const prefix = "refs/remotes/origin/"
  const value =
    found.ok && found.stdout.trim().startsWith(prefix)
      ? found.stdout.trim().slice(prefix.length)
      : ""
  evict(defaultBranches)
  defaultBranches.set(cwd, { at: Date.now(), value })
  return value
}

async function refExists(cwd: string, ref: string) {
  const found = await runGit(["show-ref", "--verify", "--quiet", ref], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  return found.ok
}

/**
 * How far ahead of the repo's *base* branch this one is, for a branch with no
 * upstream to be ahead of.
 *
 * From T3 Code's `resolveBaseBranchForNoUpstream` — a branch created for one
 * task and never pushed is the normal case for an agent, and "0 ahead, 0
 * behind" is exactly the wrong thing to say about it. The base is whatever
 * `gh` recorded when it made the branch, else `origin/HEAD`, else main, else
 * master; the remote-tracking ref is preferred over the local branch of the
 * same name because that is what a PR would be opened against.
 *
 * No `git fetch`. Ever, anywhere in this file: a sidebar poll that reaches the
 * network on its own is how a laptop's battery disappears.
 */
async function aheadOfBase(cwd: string, branch: string) {
  const configured = await runGit(
    ["config", "--get", `branch.${branch}.gh-merge-base`],
    { cwd, timeoutMs: GIT_TIMEOUT_MS }
  )
  const candidates = [
    configured.ok ? configured.stdout.trim() : "",
    await defaultBranch(cwd),
    "main",
    "master",
  ]
  let base = ""
  for (const raw of candidates) {
    const candidate = raw.startsWith("origin/") ? raw.slice("origin/".length) : raw
    if (!candidate || candidate === branch) continue
    if (await refExists(cwd, `refs/remotes/origin/${candidate}`)) {
      base = `origin/${candidate}`
      break
    }
    if (await refExists(cwd, `refs/heads/${candidate}`)) {
      base = candidate
      break
    }
  }
  if (!base) return 0
  const counted = await runGit(["rev-list", "--count", `${base}..HEAD`], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (!counted.ok) return 0
  const value = Number.parseInt(counted.stdout.trim(), 10)
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * `git diff HEAD --numstat`, with the unborn-HEAD fallback: a repo whose first
 * commit has not happened has no `HEAD` to diff against, so the staged and
 * unstaged halves are read separately and summed per path.
 */
async function readNumstat(cwd: string): Promise<NumstatFile[]> {
  const diffed = await runGit(["diff", "HEAD", "--numstat", "-z", "--"], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (diffed.ok) return parseNumstatZ(diffed.stdout)
  if (diffed.kind !== "unborn-head") return []
  const [unstaged, staged] = await Promise.all([
    runGit(["diff", "--numstat", "-z"], { cwd, timeoutMs: GIT_TIMEOUT_MS }),
    runGit(["diff", "--cached", "--numstat", "-z"], {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
    }),
  ])
  const summed = new Map<string, NumstatFile>()
  for (const result of [staged, unstaged]) {
    if (!result.ok) continue
    for (const file of parseNumstatZ(result.stdout)) {
      const existing = summed.get(file.path)
      if (existing) {
        existing.insertions += file.insertions
        existing.deletions += file.deletions
      } else {
        summed.set(file.path, { ...file })
      }
    }
  }
  return [...summed.values()].sort((a, b) => a.path.localeCompare(b.path))
}

async function readLocal(cwd: string): Promise<LocalResult> {
  if (await indexLocked(cwd)) return { ok: false, kind: "locked" }

  const [status, numstat] = await Promise.all([
    runGit(["status", "--porcelain=2", "--branch", "-z"], {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
    }),
    readNumstat(cwd),
  ])

  if (!status.ok) {
    // The one failure that is an answer: this folder is not a checkout, and
    // will not be one a second from now either.
    if (status.kind === "not-a-repo") return { ok: true, status: { ...EMPTY } }
    return { ok: false, kind: status.kind ?? "failed" }
  }

  const parsed = parsePorcelainV2Z(status.stdout)
  const stats = new Map(numstat.map((file) => [file.path, file]))
  let insertions = 0
  let deletions = 0
  for (const file of numstat) {
    insertions += file.insertions
    deletions += file.deletions
  }
  // A file `status` saw but `diff` did not is real and still worth listing —
  // an untracked file has nothing to diff against. It lands with 0/0.
  const files = [...numstat]
  for (const changed of parsed.changed) {
    if (!stats.has(changed)) {
      files.push({ path: changed, insertions: 0, deletions: 0 })
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))

  const hasUpstream = parsed.upstream.length > 0
  const aheadOfDefault =
    parsed.branch && parsed.branch !== (await defaultBranch(cwd))
      ? await aheadOfBase(cwd, parsed.branch)
      : 0

  return {
    ok: true,
    status: {
      isGitRepo: true,
      branch: parsed.branch,
      // With no upstream there is nothing to be ahead *of* except the base
      // branch, and that is the number worth showing — same choice T3 makes.
      ahead: hasUpstream ? parsed.ahead : aheadOfDefault,
      behind: hasUpstream ? parsed.behind : 0,
      dirty: parsed.changed.length,
      hasUpstream,
      aheadOfDefault,
      insertions,
      deletions,
      files,
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The remote half                                                            */
/* -------------------------------------------------------------------------- */

type PrEntry = {
  /** When this entry stops being reusable. */
  until: number
  branch: string
  pr: GitStatus["pr"]
  /** Consecutive failed lookups, for the backoff. Cleared by a success. */
  failures: number
}

const prCache = new Map<string, PrEntry>()

/** 20s, 40s, 80s … capped at 15 minutes. Per folder, cleared by a success. */
export function prFailureTtl(consecutiveFailures: number) {
  const exponent = Math.max(0, consecutiveFailures - 1)
  return Math.min(
    PR_FAILURE_BASE_TTL_MS * Math.pow(2, exponent),
    PR_FAILURE_MAX_TTL_MS
  )
}

/**
 * The branch's open pull request, through `gh`.
 *
 * `pr list --head <branch>` rather than `pr view`: `pr view` resolves whatever
 * it feels like when the branch has no PR (the default branch's, most often),
 * and it is the one shape of wrong answer a badge must not have. A miss here
 * is an empty array, which is unambiguous.
 */
async function readPullRequest(cwd: string, branch: string) {
  const listed = await runGh(
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--limit",
      "1",
      "--json",
      "number,title,url,state,isDraft,headRefName,baseRefName",
    ],
    { cwd, timeoutMs: GH_TIMEOUT_MS }
  )
  if (!listed.ok) throw new Error(listed.stderr.trim() || "gh pr list failed")
  const raw = listed.stdout.trim()
  return raw ? parsePullRequests(raw, branch) : undefined
}

/**
 * The cached PR for this folder's branch.
 *
 * A rejected lookup is never cached as an answer: the entry keeps the *last
 * good* PR and only its expiry moves out, so a rate limit or a dropped Wi-Fi
 * connection cannot make a badge the user was looking at disappear.
 */
async function cachedPullRequest(cwd: string, branch: string) {
  if (!branch) return undefined
  const hit = prCache.get(cwd)
  const known = hit?.branch === branch ? hit : undefined
  if (known && Date.now() < known.until) return known.pr
  try {
    const pr = await readPullRequest(cwd, branch)
    evict(prCache)
    prCache.set(cwd, { until: Date.now() + PR_TTL_MS, branch, pr, failures: 0 })
    return pr
  } catch {
    const failures = (known?.failures ?? 0) + 1
    evict(prCache)
    prCache.set(cwd, {
      until: Date.now() + prFailureTtl(failures),
      branch,
      pr: known?.pr,
      failures,
    })
    return known?.pr
  }
}

/* -------------------------------------------------------------------------- */
/* The two halves, joined                                                     */
/* -------------------------------------------------------------------------- */

function evict(map: Map<string, unknown>) {
  if (map.size < MAX_CACHED) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

const localCache = new Map<string, { at: number; value: LocalResult }>()
const localInflight = new Map<string, Promise<LocalResult>>()
/** The last thing that worked, per folder — what a transient failure keeps. */
const lastGood = new Map<string, GitStatus>()

async function localStatus(cwd: string): Promise<LocalResult> {
  const hit = localCache.get(cwd)
  if (hit && Date.now() - hit.at < LOCAL_TTL_MS) return hit.value
  const running = localInflight.get(cwd)
  if (running) return running
  // The promise is shared while it runs and *dropped* when it settles: only a
  // resolved value is ever cached, so a rejection cannot be handed out for a
  // whole TTL.
  const next = readLocal(cwd)
    .catch((): LocalResult => ({ ok: false, kind: "failed" }))
    .then((value) => {
      evict(localCache)
      localCache.set(cwd, { at: Date.now(), value })
      return value
    })
    .finally(() => {
      localInflight.delete(cwd)
    })
  localInflight.set(cwd, next)
  return next
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const local = await localStatus(cwd)

  if (!local.ok) {
    // A transient failure keeps the badge; anything else (no git on this
    // machine) is simply nothing to show.
    const previous = lastGood.get(cwd)
    if (previous && isTransientGitFailure(local.kind)) {
      return { ...previous, stale: true }
    }
    return { ...EMPTY, stale: true }
  }

  if (!local.status.isGitRepo) {
    lastGood.set(cwd, local.status)
    return local.status
  }

  const pr = await cachedPullRequest(cwd, local.status.branch)
  const status: GitStatus = { ...local.status, ...(pr ? { pr } : null) }
  evict(lastGood)
  lastGood.set(cwd, status)
  return status
}

/** Drops every cached read for a folder — after a revert or a checkpoint restore. */
export function invalidateGitStatus(cwd: string) {
  const key = path.resolve(cwd)
  localCache.delete(key)
  localCache.delete(cwd)
  lastGood.delete(key)
  lastGood.delete(cwd)
}
