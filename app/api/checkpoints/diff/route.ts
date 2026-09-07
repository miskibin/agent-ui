import { NextResponse } from "next/server"

import { checkpointRefFor, diffCheckpoints } from "@/lib/checkpoints"
import { crossOriginRefusal } from "@/lib/request-origin"

import { checkpointRoot, parseTurn } from "../session-root"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/checkpoints/diff?session=<id>&turn=<n>` — what turn `n` changed on
 * disk, as numstat rows.
 *
 * The pair is always `turn - 1 → turn`: checkpoints are numbered by turn and
 * the baseline before the first one is turn 0, so the previous ref is the
 * "before" without anything having to be stored to say so. Turn 0 has nothing
 * in front of it and answers with an empty list rather than an error.
 */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const params = new URL(req.url).searchParams
  const sessionId = params.get("session")?.trim() ?? ""
  const turn = parseTurn(params.get("turn") ?? undefined)
  if (turn === null) {
    return NextResponse.json({ error: "turn must be a whole number" }, { status: 400 })
  }
  const root = await checkpointRoot(sessionId)
  if (!root.ok) {
    return NextResponse.json({ error: root.error }, { status: root.status })
  }
  if (turn === 0) {
    return NextResponse.json({ files: [], from: null, to: checkpointRefFor(sessionId, 0) })
  }
  const from = checkpointRefFor(sessionId, turn - 1)
  const to = checkpointRefFor(sessionId, turn)
  const diffed = await diffCheckpoints(root.cwd, from, to)
  if (!diffed.ok) {
    return NextResponse.json({ error: diffed.error }, { status: 404 })
  }
  return NextResponse.json({ files: diffed.files, from, to })
}
