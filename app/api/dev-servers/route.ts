import { NextResponse } from "next/server"

import { discoverDevServers } from "@/lib/dev-servers"
import { crossOriginRefusal } from "@/lib/request-origin"
import { getSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/dev-servers?sessionId=…` — the local ports that answer with a
 * page, so the app can offer "open localhost:5173" instead of leaving the user
 * to find it in the transcript.
 *
 * A `sessionId` narrows the list to servers started inside that chat's folder
 * where the platform can say (see `lib/dev-servers`); without one it is every
 * local dev server on the machine.
 *
 * The port this request arrived on is excluded: the app is itself an HTML
 * server on loopback, and offering to open it is a joke that stops being funny
 * the first time someone clicks it.
 */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused

  const sessionId = new URL(req.url).searchParams.get("sessionId")?.trim()
  const session = sessionId ? await getSession(sessionId) : null
  const cwd = session?.cwd?.trim()

  const ownPort = Number.parseInt(
    (req.headers.get("host") ?? "").split(":")[1] ?? "",
    10
  )
  const servers = await discoverDevServers({
    ...(cwd ? { cwd } : null),
    ...(Number.isInteger(ownPort) ? { exclude: [ownPort] } : null),
  })
  return NextResponse.json({ servers })
}
