import path from "node:path"

import { NextResponse } from "next/server"

import { invalidateWalk } from "@/lib/fs-search"
import { invalidateGitStatus } from "@/lib/git-status"
import { crossOriginRefusal } from "@/lib/request-origin"
import { getSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `POST /api/fs/invalidate { sessionId }` — forget what the chat's folder held.
 *
 * The file list behind `@` and behind every "which file did the answer mean"
 * repair is cached per folder for half a minute, which is right while nothing
 * is happening and wrong the instant a turn ends: the agent has just created
 * the file the user is about to go looking for. The chat page calls this when
 * a turn settles, so the next `@` sees it.
 *
 * The folder is read back from the stored session, never taken from the
 * request — a cached list is cheap, but the id of a folder is not something a
 * page on another origin gets to name.
 */
export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  let body: { sessionId?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const sessionId = body.sessionId?.trim()
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 })
  }
  const session = await getSession(sessionId)
  const cwd = session?.cwd?.trim()
  if (!cwd) return NextResponse.json({ ok: true, invalidated: false })
  const root = path.resolve(cwd)
  invalidateWalk(root)
  invalidateGitStatus(root)
  return NextResponse.json({ ok: true, invalidated: true })
}
