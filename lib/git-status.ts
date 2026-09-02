import "server-only"

import { execFile } from "node:child_process"
import { promisify } from "node:util"

/**
 * One folder's git state for the sidebar: branch, ahead/behind, how many
 * files are dirty, and the pull request on the branch when `gh` is around.
 *
 * Every call is `execFile` with a fixed argv and the folder as `cwd` only —
 * the same rule `/api/fs/validate` follows. Cached briefly per folder: the
 * sidebar polls, and `gh` is a network call.
 */

const run = promisify(execFile)

const GIT_TIMEOUT_MS = 3_000
const GH_TIMEOUT_MS = 6_000
const CACHE_TTL_MS = 20_000

export type PullRequestState = "OPEN" | "MERGED" | "CLOSED"

export type GitStatus = {
  isGitRepo: boolean
  branch: string
  ahead: number
  behind: number
  /** Modified, added, deleted and untracked entries in `git status`. */
  dirty: number
  pr?: { number: number; url: string; state: PullRequestState; title: string }
}

const EMPTY: GitStatus = {
  isGitRepo: false,
  branch: "",
  ahead: 0,
  behind: 0,
  dirty: 0,
}

const cache = new Map<string, { at: number; value: Promise<GitStatus> }>()

async function exec(cmd: string, args: string[], cwd: string, timeout: number) {
  try {
    const { stdout } = await run(cmd, args, { cwd, timeout, windowsHide: true })
    return stdout
  } catch {
    return null
  }
}

/** `## main...origin/main [ahead 2, behind 1]` → the three numbers. */
function parseHeader(line: string) {
  const branch = line.replace(/^##\s*/, "").split("...")[0].split(" ")[0]
  const ahead = /ahead (\d+)/.exec(line)
  const behind = /behind (\d+)/.exec(line)
  return {
    branch: branch === "HEAD" ? "" : branch,
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
  }
}

async function readStatus(cwd: string): Promise<GitStatus> {
  const raw = await exec(
    "git",
    ["status", "--porcelain=v1", "--branch"],
    cwd,
    GIT_TIMEOUT_MS
  )
  if (raw === null) return EMPTY
  const lines = raw.split("\n").filter(Boolean)
  const header = lines.find((line) => line.startsWith("##")) ?? "##"
  const status: GitStatus = {
    isGitRepo: true,
    ...parseHeader(header),
    dirty: lines.filter((line) => !line.startsWith("##")).length,
  }

  // The PR is a nicety: no `gh`, not logged in, no remote — all "no PR".
  const pr = await exec(
    "gh",
    ["pr", "view", "--json", "number,url,state,title"],
    cwd,
    GH_TIMEOUT_MS
  )
  if (pr) {
    try {
      const parsed = JSON.parse(pr) as Partial<NonNullable<GitStatus["pr"]>>
      if (
        typeof parsed.number === "number" &&
        typeof parsed.url === "string" &&
        (parsed.state === "OPEN" ||
          parsed.state === "MERGED" ||
          parsed.state === "CLOSED")
      ) {
        status.pr = {
          number: parsed.number,
          url: parsed.url,
          state: parsed.state,
          title: typeof parsed.title === "string" ? parsed.title : "",
        }
      }
    } catch {
      /* not JSON — no PR */
    }
  }
  return status
}

export function gitStatus(cwd: string): Promise<GitStatus> {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  const value = readStatus(cwd)
  cache.set(cwd, { at: Date.now(), value })
  return value
}
