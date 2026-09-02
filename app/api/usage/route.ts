import { NextResponse } from "next/server"

import { listSessions, readMessages } from "@/lib/store/sessions"
import {
  aggregateUsage,
  usageTurns,
  withinWindow,
  type UsageTurn,
} from "@/lib/usage"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/usage?days=30` — tokens and estimated cost across every stored
 * chat, grouped by model and by working folder. `days=all` drops the window.
 *
 * Aggregated server-side on purpose: the alternative is the settings page
 * fetching every transcript to add up numbers, which would ship megabytes of
 * message bodies to the browser to render two small tables. The response
 * carries rows only — no message ever leaves the store through this route.
 */

/** Windows the UI offers. Anything else is clamped into this range. */
const MAX_DAYS = 3650

/**
 * Per-session turns, keyed by the `updatedAt` they were read at. A chat's
 * transcript only changes when its index entry does, so reopening the page —
 * or switching between 7d and 30d — re-reads nothing.
 */
const cache = new Map<string, { updatedAt: number; turns: UsageTurn[] }>()

function parseDays(raw: string | null): number | null {
  const value = raw?.trim().toLowerCase() ?? ""
  if (value === "all") return null
  if (!value) return 30
  const days = Number(value)
  if (!Number.isFinite(days) || days <= 0) return 30
  return Math.min(Math.trunc(days), MAX_DAYS)
}

export async function GET(req: Request) {
  const days = parseDays(new URL(req.url).searchParams.get("days"))
  const sessions = await listSessions()
  const since = days == null ? null : Date.now() - days * 24 * 60 * 60 * 1000

  const live = new Set(sessions.map((session) => session.id))
  for (const id of cache.keys()) {
    if (!live.has(id)) cache.delete(id)
  }

  const turnsByChat = await Promise.all(
    sessions.map(async (session) => {
      const hit = cache.get(session.id)
      if (hit && hit.updatedAt === session.updatedAt) return hit.turns
      // An empty chat has no transcript file to read at all.
      const turns =
        session.messageCount === 0
          ? []
          : usageTurns(session, await readMessages(session.id))
      cache.set(session.id, { updatedAt: session.updatedAt, turns })
      return turns
    })
  )

  return NextResponse.json(
    aggregateUsage(
      turnsByChat.map((turns) => withinWindow(turns, since)),
      { days, since }
    )
  )
}
