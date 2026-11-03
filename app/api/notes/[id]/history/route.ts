import { NextResponse } from "next/server"

import { getNoteMeta, listNoteHistory, readNoteAt, restoreNote } from "@/lib/notes/server"
import { crossOriginRefusal } from "@/lib/request-origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** The revisions kept for the note, newest first; `?rev=` returns one's content. */
export async function GET(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  if (!(await getNoteMeta(id))) return NextResponse.json({ error: "Note not found" }, { status: 404 })
  const rev = Number(new URL(req.url).searchParams.get("rev"))
  if (Number.isFinite(rev) && rev > 0) {
    const content = await readNoteAt(id, rev)
    return content === undefined
      ? NextResponse.json({ error: "That revision is no longer kept" }, { status: 404 })
      : NextResponse.json({ rev, content })
  }
  return NextResponse.json({ history: await listNoteHistory(id) })
}

/** Restores `{ rev }` as a new revision, so the restore itself can be undone. */
export async function POST(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  let body: { rev?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  if (typeof body.rev !== "number") return NextResponse.json({ error: "rev is required" }, { status: 400 })
  const doc = await restoreNote(id, body.rev)
  return doc ? NextResponse.json(doc) : NextResponse.json({ error: "That revision is no longer kept" }, { status: 404 })
}
