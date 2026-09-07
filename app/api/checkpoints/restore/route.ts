import { NextResponse } from "next/server"

import { checkpointRefFor, restoreCheckpoint } from "@/lib/checkpoints"
import { invalidateWalk } from "@/lib/fs-search"
import { invalidateGitStatus } from "@/lib/git-status"
import { crossOriginRefusal } from "@/lib/request-origin"

import { checkpointRoot, parseTurn } from "../session-root"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `POST /api/checkpoints/restore { sessionId, turn }` — put the chat's folder
 * back the way it stood at the end of turn `turn`.
 *
 * This *deletes work*: files the agent created since are removed and files it
 * changed are overwritten. Asking first is the UI's job — the same
 * confirm-through-a-toast-action "Revert changes" uses — and this route does
 * only what it is told, under the same containment as `/api/git/revert`: the
 * folder comes from the stored session, the app's data directory is refused,
 * and every git argument is the literal `.`.
 */
export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  let body: { sessionId?: string; turn?: number }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const turn = parseTurn(body.turn)
  if (turn === null) {
    return NextResponse.json({ error: "turn must be a whole number" }, { status: 400 })
  }
  const root = await checkpointRoot(body.sessionId)
  if (!root.ok) {
    return NextResponse.json({ error: root.error }, { status: root.status })
  }
  const ref = checkpointRefFor(body.sessionId!.trim(), turn)
  const restored = await restoreCheckpoint(root.cwd, ref)
  if (!restored.ok) {
    return NextResponse.json({ error: restored.error }, { status: 409 })
  }
  // Everything cached about that folder describes a worktree that no longer
  // exists: the file list behind `@`, and the sidebar's dirty count.
  invalidateWalk(root.cwd)
  invalidateGitStatus(root.cwd)
  return NextResponse.json({ ok: true, ref, commit: restored.commit })
}
