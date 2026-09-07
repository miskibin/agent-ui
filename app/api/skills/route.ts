import { NextResponse } from "next/server"

import { crossOriginRefusal } from "@/lib/request-origin"
import { scanSkills } from "@/lib/skills-scan"
import { getSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/skills?sessionId=<id>` — the skills the composer's `$` menu
 * offers and the provider commands its `/` menu adds, for one chat.
 *
 * The folder comes from the stored session, never from the request: the
 * client names a chat and the server decides what that chat may see, the same
 * rule `/api/fs/search` and `/api/file` follow. Without a folder only the
 * user-scoped ones are there, which is exactly what a chat with no cwd can
 * run.
 */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused

  const params = new URL(req.url).searchParams
  // `session` too, so this route answers the spelling every other one uses.
  const sessionId = (params.get("sessionId") ?? params.get("session") ?? "").trim()
  const session = sessionId ? await getSession(sessionId) : null
  const catalog = await scanSkills(session?.cwd?.trim() || undefined)
  return NextResponse.json(catalog)
}
