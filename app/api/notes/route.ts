import { NextResponse } from "next/server"

import { createNote, listNotes, MAX_NOTE_CHARS } from "@/lib/notes/server"
import { crossOriginRefusal } from "@/lib/request-origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The notes the sidebar lists — metadata only. */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  return NextResponse.json({ notes: await listNotes() })
}

export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  let body: { content?: unknown } = {}
  try {
    body = (await req.json()) as { content?: unknown }
  } catch {
    /* an empty body is an empty note */
  }
  const content = typeof body.content === "string" ? body.content.slice(0, MAX_NOTE_CHARS) : ""
  return NextResponse.json(await createNote(content), { status: 201 })
}
