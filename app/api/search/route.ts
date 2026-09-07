import { NextResponse } from "next/server"

import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_QUERY,
  searchMessages,
  searchableMessages,
  searchableSize,
  type SearchableMessage,
} from "@/lib/message-search"
import { LRUCache } from "@/lib/lru-cache"
import { crossOriginRefusal } from "@/lib/request-origin"
import { listSessions, readMessages } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/search?q=<query>&limit=<n>` — the chats whose *messages* match,
 * for the command palette's Messages group.
 *
 * Server-side for the same reason `app/api/usage` is: the alternative is the
 * palette fetching every transcript in the store to grep them in the browser,
 * which would ship megabytes of message bodies on every keystroke. The answer
 * carries one snippet per chat and nothing else — no transcript leaves the
 * store through this route.
 *
 * The ranking and the snippets are `lib/message-search`'s, which is pure; all
 * this adds is the reading and the caching.
 */

/**
 * Only the newest chats are walked. A query that is worth typing is about
 * something recent, and the alternative is an unbounded read of the whole
 * store on a keystroke.
 */
const MAX_SESSIONS = 500

/**
 * Per-session searchable text, keyed by the `updatedAt` it was read at — the
 * same trick `app/api/usage` uses for its turns. A chat's transcript can only
 * change when its index entry does, so the key going stale *is* the
 * invalidation, and typing one more character re-reads nothing.
 *
 * Size-aware, unlike usage's plain `Map`: what is held here is message text,
 * and a few hundred long chats are megabytes rather than counters. The oldest
 * entries leave when either bound is reached, which also collects the keys of
 * chats that have since been edited or deleted.
 */
const MAX_CACHED_CHATS = 400
const MAX_CACHED_CHARS = 8 * 1024 * 1024
const cache = new LRUCache<SearchableMessage[]>(MAX_CACHED_CHATS, MAX_CACHED_CHARS)

function parseLimit(raw: string | null) {
  const value = Number(raw?.trim() ?? "")
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SEARCH_LIMIT
  return Math.min(Math.trunc(value), MAX_SEARCH_LIMIT)
}

export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused

  const params = new URL(req.url).searchParams
  const query = params.get("q") ?? ""
  const limit = parseLimit(params.get("limit"))

  if (query.trim().length < MIN_SEARCH_QUERY) {
    return NextResponse.json({ query: "", matches: [], hasMore: false })
  }

  const sessions = await listSessions()
  // `listSessions` is already newest-first inside its groups; sort explicitly
  // so the cap keeps the newest chats whatever order the index arrives in.
  const newest = [...sessions]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_SESSIONS)

  return NextResponse.json(
    await searchMessages({
      index: newest,
      query,
      limit,
      loadThread: async (session) => {
        const key = `${session.id}:${session.updatedAt}`
        const hit = cache.get(key)
        if (hit) return hit
        // An empty chat has no transcript file to read at all.
        const searchable =
          session.messageCount === 0
            ? []
            : searchableMessages(await readMessages(session.id))
        cache.set(key, searchable, searchableSize(searchable))
        return searchable
      },
    })
  )
}
