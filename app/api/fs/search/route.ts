import { readdir } from "node:fs/promises"
import path from "node:path"

import { NextResponse } from "next/server"

import { getSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/fs/search?session=<id>&q=<query>` — files under the chat's
 * working folder, fuzzy-matched for the composer's `@` menu.
 *
 * The tree is walked once and cached per folder for a short while: a menu
 * that re-walks a monorepo on every keystroke would be unusable. The walk is
 * bounded (depth, file count) and skips the directories nobody @-mentions.
 * The root comes from the stored session, never from the request.
 */

const MAX_FILES = 20_000
const MAX_DEPTH = 12
const MAX_RESULTS = 20
const CACHE_TTL_MS = 30_000

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

type Walk = { at: number; files: string[]; truncated: boolean }
const walks = new Map<string, Promise<Walk>>()
/** A few roots at a time; each can hold `MAX_FILES` paths. */
const MAX_ROOTS = 8

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

async function walkCached(root: string) {
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

/**
 * Subsequence match with a score that likes matches at the start of a path
 * segment, runs of consecutive hits, and short paths. Good enough for a menu;
 * nothing here needs to be clever.
 */
function score(candidate: string, query: string): number {
  if (!query) return 1
  const lower = candidate.toLowerCase()
  let qi = 0
  let total = 0
  let streak = 0
  for (let i = 0; i < lower.length && qi < query.length; i++) {
    if (lower[i] !== query[qi]) {
      streak = 0
      continue
    }
    const boundary = i === 0 || lower[i - 1] === "/" || lower[i - 1] === "."
    total += 10 + (boundary ? 8 : 0) + streak * 3
    streak++
    qi++
  }
  if (qi < query.length) return 0
  // Matches in the file name beat matches spread across directories.
  const name = lower.slice(lower.lastIndexOf("/") + 1)
  if (name.includes(query)) total += 30
  if (name.startsWith(query)) total += 20
  return total - Math.min(candidate.length, 80) * 0.15
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams
  const sessionId = params.get("session")?.trim() ?? ""
  const query = (params.get("q") ?? "").trim().toLowerCase()

  const session = sessionId ? await getSession(sessionId) : null
  const root = session?.cwd?.trim()
  if (!root) return NextResponse.json({ files: [], truncated: false })

  const { files, truncated } = await walkCached(path.resolve(root))
  const ranked = files
    .map((file) => ({ file, score: score(file, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.file)
  return NextResponse.json({ files: ranked, truncated })
}
