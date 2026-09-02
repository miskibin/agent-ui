import path from "node:path"

import { NextResponse } from "next/server"

import { walkCached } from "@/lib/fs-search"
import { getSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/fs/search?session=<id>&q=<query>` — files under the chat's
 * working folder, fuzzy-matched for the composer's `@` menu.
 *
 * The walk itself lives in `lib/fs-search` — bounded, cached per folder and
 * shared with the path resolution the preview panel and the "Open in …" menu
 * do. The root comes from the stored session, never from the request.
 */

const MAX_RESULTS = 20

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
