import { NextResponse } from "next/server"

import { activeNoteAsk, cancelNoteAsk } from "@/lib/notes/runs"
import { deleteNote, listThreads, MAX_NOTE_CHARS, readNote, saveNote } from "@/lib/notes/server"
import { crossOriginRefusal } from "@/lib/request-origin"
import { deleteSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** The note, its threads and which of them an agent is working on. */
export async function GET(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  // `?part=threads`: the threads alone, for the page following an ask.
  if (new URL(req.url).searchParams.get("part") === "threads") {
    return NextResponse.json({ threads: await listThreads(id), activeThread: activeNoteAsk(id) ?? null })
  }
  const doc = await readNote(id)
  if (!doc) return NextResponse.json({ error: "Note not found" }, { status: 404 })
  return NextResponse.json({ ...doc, threads: await listThreads(id), activeThread: activeNoteAsk(id) ?? null })
}

/**
 * The person's save. `baseRev` and `base` are the revision the page last had
 * and its content; when the note moved on since, the save is merged into what
 * is there now and the merged note comes back.
 */
export async function PUT(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  let body: { content?: unknown; baseRev?: unknown; base?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  if (typeof body.content !== "string" || typeof body.baseRev !== "number") {
    return NextResponse.json({ error: "content and baseRev are required" }, { status: 400 })
  }
  if (body.content.length > MAX_NOTE_CHARS) {
    return NextResponse.json({ error: "The note is too large." }, { status: 413 })
  }
  const saved = await saveNote(id, {
    content: body.content,
    baseRev: body.baseRev,
    ...(typeof body.base === "string" ? { base: body.base } : null),
  })
  if (!saved) return NextResponse.json({ error: "Note not found" }, { status: 404 })
  return NextResponse.json(saved)
}

export async function DELETE(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  cancelNoteAsk(id)
  const meta = await deleteNote(id)
  if (!meta) return NextResponse.json({ error: "Note not found" }, { status: 404 })
  if (meta.chatId) await deleteSession(meta.chatId).catch(() => false)
  return NextResponse.json({ ok: true })
}
