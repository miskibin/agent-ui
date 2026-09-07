import { NextResponse } from "next/server"

import { crossOriginRefusal } from "@/lib/request-origin"
import {
  clearSessions,
  createSession,
  listSessions,
  normalizeWorktree,
  readLifecyclePatch,
} from "@/lib/store/sessions"
import type { CreateSessionInput } from "@/lib/store/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The sidebar index — metadata only, never message bodies. */
export async function GET() {
  return NextResponse.json({ sessions: await listSessions() })
}

export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
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
    // The picker mints this when it creates a worktree for the chat, so a
    // chat that starts in one remembers the repository it belongs to.
    worktree: normalizeWorktree(body.worktree),
    permissionMode:
      typeof body.permissionMode === "string" ? body.permissionMode : undefined,
    ...readLifecyclePatch(body),
  })
  return NextResponse.json({ session }, { status: 201 })
}

/** Wipes every thread. The settings page's Data section calls this route. */
export async function DELETE(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  return NextResponse.json({ deleted: await clearSessions() })
}
