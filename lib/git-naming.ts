/**
 * The names a worktree gets: its branch, and the folder that branch lives in.
 *
 * Pure and free of `node:` — the composer's folder picker shows the name a
 * worktree *would* be created under before anything is created, so the same
 * helpers have to run in the browser and on the server and agree, character
 * for character, about what they produce.
 *
 * A branch name here is built, never interpolated. Git's rules for a ref are
 * long (no `..`, no `@{`, no leading `-`, no trailing `.lock`, no `//`, no
 * control characters, no space) and a chat title is whatever the user typed —
 * so rather than escape a title, `sanitizeBranchFragment` reduces it to an
 * alphabet where none of those rules can be broken: lowercase letters, digits,
 * `-`, `_` and `/`. Everything else becomes a dash.
 */

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/** Namespace for the branches this app mints without being told a name. */
export const WORKTREE_BRANCH_PREFIX = "agent-ui"

/** What a title reduces to when it held nothing usable. */
const FALLBACK_FRAGMENT = "update"

/**
 * Canonical form of a name nobody chose: `agent-ui/<8 hex>` (the random form)
 * or `agent-ui/<yyyymmdd-hhmmss>` (the one the picker offers, which reads as
 * *when* rather than as noise). Both are recognized so a later cleanup can
 * tell "a branch this app invented" from "a branch the user named".
 */
const TEMPORARY_BRANCH_PATTERN = new RegExp(
  `^${WORKTREE_BRANCH_PREFIX}\\/(?:[0-9a-f]{8}|\\d{8}-\\d{6})$`
)

/**
 * An arbitrary string reduced to a valid, lowercase ref fragment: quotes
 * dropped, every other run of unusable characters collapsed to one dash,
 * separators collapsed, and the whole thing capped at 64 characters so a
 * pasted paragraph cannot become a path component no filesystem will take.
 */
export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "")

  const fragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "")

  return fragment.length > 0 ? fragment : FALLBACK_FRAGMENT
}

/**
 * The same, under a `feature/` namespace — unless the name already carries a
 * namespace of its own, which is the user having already said where it goes.
 */
export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw)
  if (sanitized.includes("/")) {
    return sanitized.startsWith("feature/") ? sanitized : `feature/${sanitized}`
  }
  return `feature/${sanitized}`
}

/** Titles that name nothing — a chat that has not been named yet. */
const PLACEHOLDER_TITLES = new Set(["new chat", "untitled", "chat"])

/**
 * The branch a new worktree gets when the user did not type one: the chat's
 * own title, or a timestamp when the chat has no title worth using.
 *
 * A placeholder title is deliberately *not* turned into `feature/new-chat`:
 * every chat starts with the same one, so the second worktree would collide
 * with the first and be silently renamed to `-2`.
 */
export function resolveAutoFeatureBranchName(title?: string): string {
  const trimmed = title?.trim() ?? ""
  if (!trimmed || PLACEHOLDER_TITLES.has(trimmed.toLowerCase())) {
    return buildTimestampWorktreeBranchName()
  }
  const fragment = sanitizeBranchFragment(trimmed)
  if (fragment === FALLBACK_FRAGMENT) return buildTimestampWorktreeBranchName()
  return sanitizeFeatureBranchName(fragment)
}

/** Eight lowercase hex characters, from whatever source the caller has. */
function defaultRandomHex(byteLength: number): string {
  let hex = ""
  for (let index = 0; index < byteLength; index += 1) {
    hex += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0")
  }
  return hex
}

/**
 * `agent-ui/<8 hex>`. The callback is normalized rather than trusted: a
 * `randomUUID`-shaped source still produces the canonical form.
 *
 * This is a label, not a secret — two chats colliding on it costs a `-2`
 * suffix, so `Math.random` is the right amount of machinery.
 */
export function buildTemporaryWorktreeBranchName(
  randomHex: (byteLength: number) => string = defaultRandomHex
): string {
  const token = randomHex(4)
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "")
    .slice(0, 8)
    .padEnd(8, "0")
  return `${WORKTREE_BRANCH_PREFIX}/${token}`
}

/** `agent-ui/<yyyymmdd-hhmmss>`, in local time — the picker's default. */
export function buildTimestampWorktreeBranchName(at: Date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${WORKTREE_BRANCH_PREFIX}/${stamp}`
}

/** Did this app invent this branch name, or did a person choose it? */
export function isTemporaryWorktreeBranch(refName: string): boolean {
  return TEMPORARY_BRANCH_PATTERN.test(refName.trim().toLowerCase())
}

/**
 * A remote URL reduced to a stable comparison key: `host/owner/repo`, with
 * the scheme, the trailing `.git` and the case dropped.
 *
 * The scp-style form (`git@github.com:owner/repo.git`) is the one that needs
 * the extra pass — it is not a URL, so `new URL()` reads the whole thing as an
 * opaque `git@github.com:…` path and hands back nothing comparable.
 */
export function normalizeGitRemoteUrl(value: string): string {
  const normalized = value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase()

  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized)
      const repositoryPath = url.pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .join("/")
      if (url.hostname && repositoryPath.includes("/")) {
        return `${url.hostname}/${repositoryPath}`
      }
    } catch {
      return normalized
    }
  }

  const scpStyle = /^[a-z0-9._-]+@([^:/\s]+):([^/\s]+(?:\/[^/\s]+)+)$/i.exec(
    normalized
  )
  if (scpStyle?.[1] && scpStyle[2]) return `${scpStyle[1]}/${scpStyle[2]}`

  return normalized
}

/**
 * `desired`, or the first `desired-2`, `desired-3`, … that nothing in `taken`
 * already answers to. Comparison is case-insensitive: on macOS and Windows
 * `refs/heads/Feature/X` and `refs/heads/feature/x` are one file.
 *
 * Never fails. A hundred collisions is not a name to keep counting past, so
 * the last resort is a timestamp suffix, which cannot collide with the ones
 * already tried.
 */
export function resolveAvailableBranchName(
  desired: string,
  taken: readonly string[]
): string {
  const existing = new Set(taken.map((name) => name.trim().toLowerCase()))
  if (!existing.has(desired.toLowerCase())) return desired
  for (let suffix = 2; suffix <= 100; suffix += 1) {
    const candidate = `${desired}-${suffix}`
    if (!existing.has(candidate.toLowerCase())) return candidate
  }
  return `${desired}-${Date.now().toString(36)}`
}
