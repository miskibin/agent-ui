import { NextResponse } from "next/server"

import { clearSessions, createSession, listSessions } from "@/lib/store/sessions"
import type { CreateSessionInput } from "@/lib/store/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The sidebar index — metadata only, never message bodies. */
export async function GET() {
  return NextResponse.json({ sessions: await listSessions() })
}

export async function POST(req: Request) {
  let body: CreateSessionInput = {}
  try {
    body = (await req.json()) as CreateSessionInput
  } catch {
    /* an empty body means "a blank chat with defaults" */
  }
  const session = await createSession({
    title: body.title,
    providerId: body.providerId,
    model: body.model,
    cwd: body.cwd,
    gitBranch: body.gitBranch,
  })
  return NextResponse.json({ session }, { status: 201 })
}

/** Wipes every thread. The settings page's Data section calls this route. */
export async function DELETE() {
  return NextResponse.json({ deleted: await clearSessions() })
}
