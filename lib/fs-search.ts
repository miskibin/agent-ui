import "server-only"

import { readdir, stat } from "node:fs/promises"
import path from "node:path"

/**
 * One bounded walk of a chat's working folder, shared by everything that has
 * to turn a name into a file: the composer's `@` menu, the preview panel and
 * the "Open in …" menu.
 *
 * It exists because an agent names files the way it thinks of them, not the
 * way the filesystem does. Cursor writes `` `Messages.tsx` `` in an answer and
 * `360:363:frontend/app/globals.css` above a snippet; neither is a path
 * relative to the chat's folder, so joining it with the cwd lands on nothing
 * and every click on it dies. `resolveInRoot` is the repair: the direct join
 * first, then the walk, matching on the deepest path suffix that is unique.
 *
 * The walk is cached per folder for a short while — a menu that re-walks a
 * monorepo on every keystroke would be unusable — and bounded in depth and
 * count, skipping the directories nobody ever means.
 */

const MAX_FILES = 20_000
const MAX_DEPTH = 12
const CACHE_TTL_MS = 30_000
/** A few roots at a time; each can hold `MAX_FILES` paths. */
const MAX_ROOTS = 8

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  ".idea",
  ".vscode",
  "vendor",
  ".pnpm-store",
])

export type Walk = { at: number; files: string[]; truncated: boolean }

const walks = new Map<string, Promise<Walk>>()

async function walk(root: string): Promise<Walk> {
  const files: string[] = []
  let truncated = false
  const visit = async (dir: string, depth: number) => {
    if (truncated || depth > MAX_DEPTH) return
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (truncated) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await visit(full, depth + 1)
      } else if (entry.isFile()) {
        files.push(path.relative(root, full).split(path.sep).join("/"))
        if (files.length >= MAX_FILES) truncated = true
      }
    }
  }
  await visit(root, 0)
  return { at: Date.now(), files, truncated }
}

/** The walk for `root`, reused for `CACHE_TTL_MS`. */
export async function walkCached(root: string): Promise<Walk> {
  const cached = walks.get(root)
  if (cached) {
    const current = await cached
    if (Date.now() - current.at < CACHE_TTL_MS) return current
  }
  const next = walk(root)
  if (walks.size >= MAX_ROOTS) {
    const oldest = walks.keys().next().value
    if (oldest !== undefined) walks.delete(oldest)
  }
  walks.set(root, next)
  return next
}

/** Windows and macOS compare paths without case; Linux does not. */
const CASE_INSENSITIVE =
  process.platform === "win32" || process.platform === "darwin"

function comparable(value: string) {
  return CASE_INSENSITIVE ? value.toLowerCase() : value
}

/** `a\b\c`, `./a/b`, `/a/b` → `a/b/c` — the shape `walk` stores. */
function normalizeNeedle(requested: string) {
  return requested
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
}

async function isFile(target: string) {
  try {
    return (await stat(/*turbopackIgnore: true*/ target)).isFile()
  } catch {
    return false
  }
}

/**
 * How many trailing segments a candidate shares with the name that was asked
 * for. `frontend/app/globals.css` shares three with `app/globals.css` and one
 * with a bare `globals.css`; zero means the file names differ, and a candidate
 * that does not even share its name is not a candidate.
 */
function sharedSuffix(candidate: string, needleSegments: string[]) {
  const segments = candidate.split("/")
  let shared = 0
  while (
    shared < needleSegments.length &&
    shared < segments.length &&
    comparable(segments[segments.length - 1 - shared]) ===
      comparable(needleSegments[needleSegments.length - 1 - shared])
  ) {
    shared++
  }
  return shared
}

export type ResolvedPath = {
  /** Absolute path on this machine. */
  absolute: string
  /** The same file relative to `root`, in `/` form. */
  relative: string
  /** False when the walk found it under a longer path than the one asked for. */
  exact: boolean
}

/**
 * The file `requested` means inside `root`, or null.
 *
 * An absolute path is taken as it stands. A relative one is joined with the
 * root first; only when that names nothing does the walk run, and then the
 * deepest suffix agreement wins — and it has to be the only one at that depth.
 * So a bare `Messages.tsx` resolves when one file carries that name, and a
 * `utils.ts` that two packages both carry resolves to nothing: opening one of
 * them would be a guess, and the wrong file in the panel is worse than an
 * empty one.
 */
export async function resolveInRoot(
  root: string,
  requested: string
): Promise<ResolvedPath | null> {
  const needle = normalizeNeedle(requested)
  if (!needle) return null

  const direct = path.resolve(root, needle)
  if (await isFile(direct)) {
    return {
      absolute: direct,
      relative: path.relative(root, direct).split(path.sep).join("/"),
      exact: true,
    }
  }

  const segments = needle.split("/").filter(Boolean)
  const { files } = await walkCached(path.resolve(root))
  let best = ""
  let bestShared = 0
  let ambiguous = false
  for (const file of files) {
    const shared = sharedSuffix(file, segments)
    if (shared === 0 || shared < bestShared) continue
    if (shared > bestShared) {
      best = file
      bestShared = shared
      ambiguous = false
    } else if (file !== best) {
      ambiguous = true
    }
  }
  if (!best || ambiguous) return null
  return {
    absolute: path.resolve(root, best),
    relative: best,
    exact: false,
  }
}
