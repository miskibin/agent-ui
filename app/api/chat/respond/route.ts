import { NextResponse } from "next/server"

import { crossOriginRefusal } from "@/lib/request-origin"
import {
  answerUserRequest,
  sanitizeUserRequestAnswer,
} from "@/lib/turn-requests"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RespondBody = {
  /** App session id — the chat whose turn is blocked. */
  sessionId?: string
  /** The `requestId` the waiting tool row carried. */
  requestId?: string
  answer?: unknown
}

/**
 * The second half of `POST /api/chat`: a turn that is blocked on the user
 * parked a promise in `lib/turn-requests`, and this is the request that
 * resolves it. It answers nothing itself — the outcome reaches the page as
 * another tool event on the SSE stream the turn is still holding open.
 */
export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused

  let body: RespondBody
  try {
    body = (await req.json()) as RespondBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const sessionId = body.sessionId?.trim()
  const requestId = body.requestId?.trim()
  if (!sessionId || !requestId) {
    return NextResponse.json(
      { error: "sessionId and requestId are required" },
      { status: 400 }
    )
  }

  const answer = sanitizeUserRequestAnswer(body.answer)
  if (!answer) {
    return NextResponse.json(
      { error: "answer must carry an optionId, text, or cancelled" },
      { status: 400 }
    )
  }

  // Nothing waiting is a 404, not a 500: the turn may have been stopped, or
  // the same answer may already have been delivered by another tab.
  if (!answerUserRequest(sessionId, requestId, answer)) {
    return NextResponse.json(
      { error: "No request is waiting on an answer" },
      { status: 404 }
    )
  }
  return NextResponse.json({ ok: true })
}
