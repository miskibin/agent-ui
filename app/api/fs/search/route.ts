import path from "node:path"

import { NextResponse } from "next/server"

import { walkCached } from "@/lib/fs-search"
import {
  MATCH_TIER,
  insertRankedResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedResult,
} from "@/lib/search-ranking"
import { crossOriginRefusal } from "@/lib/request-origin"
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
 * The file name is what the user is typing. A path match still counts —
 * `app/api` finds everything under it — but it can never outrank a name, so
 * the path's tiers sit one whole tier-block above the name's.
 */
const PATH_TIER_OFFSET = MATCH_TIER.fuzzy + 10_000

/**
 * How well one repo-relative path answers the query, or null for "not a
 * match". The tiers come from `lib/search-ranking`: an exact name first, then
 * a prefix, a word boundary, a substring, and a scattered subsequence last.
 * Lower is better.
 */
function scorePath(file: string, query: string): number | null {
  if (!query) return 0
  const lower = file.toLowerCase()
  const name = lower.slice(lower.lastIndexOf("/") + 1)
  const nameScore = scoreQueryMatch({
    value: name,
    query,
    exactBase: MATCH_TIER.exact,
    prefixBase: MATCH_TIER.prefix,
    boundaryBase: MATCH_TIER.boundary,
    includesBase: MATCH_TIER.includes,
    fuzzyBase: MATCH_TIER.fuzzy,
  })
  if (nameScore !== null) return nameScore
  const pathScore = scoreQueryMatch({
    value: lower,
    query,
    prefixBase: MATCH_TIER.prefix,
    boundaryBase: MATCH_TIER.boundary,
    includesBase: MATCH_TIER.includes,
    fuzzyBase: MATCH_TIER.fuzzy,
  })
  return pathScore === null ? null : pathScore + PATH_TIER_OFFSET
}

export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const params = new URL(req.url).searchParams
  const sessionId = params.get("session")?.trim() ?? ""
  // The composer may or may not have eaten the sigil it opened the menu with.
  const query = normalizeSearchQuery(params.get("q") ?? "", {
    trimLeadingPattern: /^@+/,
  })

  const session = sessionId ? await getSession(sessionId) : null
  const root = session?.cwd?.trim()
  if (!root) return NextResponse.json({ files: [], truncated: false })

  const { files, truncated } = await walkCached(path.resolve(root))
  // Bounded insertion rather than sort-then-slice: a checkout can hand back
  // tens of thousands of paths, and only twenty of them are ever shown.
  const ranked: RankedResult<string>[] = []
  for (const file of files) {
    const score = scorePath(file, query)
    if (score === null) continue
    insertRankedResult(ranked, { item: file, score, tieBreaker: file }, MAX_RESULTS)
  }
  return NextResponse.json({ files: ranked.map((entry) => entry.item), truncated })
}
