import { NextResponse } from "next/server"

import { checkpointRoot } from "@/app/api/checkpoints/session-root"
import { push } from "@/lib/git-commit"
import { invalidateGitStatus } from "@/lib/git-status"
import { crossOriginRefusal } from "@/lib/request-origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `POST /api/git/push { sessionId }` — pushes the chat folder's current
 * branch, setting its upstream the first time.
 *
 * The failure is typed rather than flattened into a message: "you are not
 * signed in" and "the remote moved on" want different offers from the UI, and
 * a push that fails because credentials are missing must not read as a network
 * blip the user should retry. See `classifyPushFailure`.
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

  const root = await checkpointRoot(body.sessionId)
  if (!root.ok) {
    return NextResponse.json({ error: root.error }, { status: root.status })
  }

  const result = await push(root.cwd)
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, kind: result.kind },
      // A refused credential is the caller's problem to solve, not a server
      // fault; a rejected push is a conflict.
      { status: result.kind === "rejected" ? 409 : 502 }
    )
  }
  invalidateGitStatus(root.cwd)
  return NextResponse.json({
    ok: true,
    branch: result.branch,
    created: result.created,
  })
}
