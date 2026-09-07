import { NextResponse } from "next/server"

import {
  captureCheckpoint,
  checkpointRefFor,
  diffCheckpoints,
  hasCheckpointRef,
} from "@/lib/checkpoints"
import { invalidateGitStatus } from "@/lib/git-status"
import { crossOriginRefusal } from "@/lib/request-origin"
import { readMessages, upsertMessages } from "@/lib/store/sessions"
import type { TurnCheckpoint } from "@/lib/store/types"

import { checkpointRoot, parseTurn } from "../session-root"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `POST /api/checkpoints/capture { sessionId, turn, ifMissing?, messageId?,
 * baseTurn? }` — the worktree as it stands, committed to this chat's hidden
 * ref for `turn`.
 *
 * Called twice per turn by `app/hooks/use-turn-runner`: once before the agent
 * starts, with `ifMissing` (the baseline is only taken when nothing already
 * recorded that state — a chat that has been running does not need one per
 * turn), and once when the turn settles.
 *
 * The second call names the assistant message, and this route writes the
 * checkpoint onto it — server-side, through the same merge-by-id the streaming
 * turn uses. Patching it from the client would not survive a reload, and the
 * numstat between the two refs is the ground truth the file card wants: what
 * the turn changed on *disk*, not what its tool calls said it changed.
 */
export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  let body: {
    sessionId?: string
    turn?: number
    baseTurn?: number
    messageId?: string
    ifMissing?: boolean
  }
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
  const sessionId = body.sessionId!.trim()
  const ref = checkpointRefFor(sessionId, turn)

  if (body.ifMissing && (await hasCheckpointRef(root.cwd, ref))) {
    return NextResponse.json({ ok: true, ref, captured: false })
  }

  const captured = await captureCheckpoint(root.cwd, ref)
  if (!captured.ok) {
    return NextResponse.json({ error: captured.error }, { status: 500 })
  }
  // A capture reads the whole tree; the sidebar's one-second cache is stale
  // by definition now.
  invalidateGitStatus(root.cwd)

  const baseTurn = parseTurn(body.baseTurn)
  const baseRef = baseTurn === null ? undefined : checkpointRefFor(sessionId, baseTurn)
  const checkpoint: TurnCheckpoint = {
    ref,
    turn,
    ...(baseRef ? { baseRef } : null),
  }
  if (baseRef) {
    const diffed = await diffCheckpoints(root.cwd, baseRef, ref)
    // A diff that failed (the baseline never happened, the read was too big)
    // leaves the rows off; the card falls back to the tool-derived list.
    if (diffed.ok) checkpoint.files = diffed.files
  }

  const messageId = body.messageId?.trim()
  if (messageId) {
    const stored = await readMessages(sessionId)
    const message = stored.find((entry) => entry.id === messageId)
    if (message) {
      await upsertMessages(sessionId, [
        { ...message, metadata: { ...message.metadata, checkpoint } },
      ])
    }
  }

  return NextResponse.json({ ok: true, ref, captured: true, checkpoint })
}
