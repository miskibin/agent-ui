import { NextResponse } from "next/server"

import { getNoteMeta, updateThreads } from "@/lib/notes/server"
import { crossOriginRefusal } from "@/lib/request-origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** Resolves or reopens a thread: `{ threadId, resolved }`. */
export async function PATCH(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  if (!(await getNoteMeta(id))) return NextResponse.json({ error: "Note not found" }, { status: 404 })
  let body: { threadId?: unknown; resolved?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const threadId = typeof body.threadId === "string" ? body.threadId : ""
  const resolved = body.resolved === true
  const found = await updateThreads(id, (threads) => {
    let hit = false
    const next = threads.map((thread) => {
      if (thread.id !== threadId) return thread
      hit = true
      return { ...thread, resolved, updatedAt: Date.now() }
    })
    return { threads: next, value: hit }
  })
  return found ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Thread not found" }, { status: 404 })
}

/** Deletes `?thread=` — a finished one; a running ask is stopped first. */
export async function DELETE(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  const threadId = new URL(req.url).searchParams.get("thread") ?? ""
  const removed = await updateThreads(id, (threads) => {
    const next = threads.filter(
      (thread) => thread.id !== threadId || thread.status === "running" || thread.status === "queued"
    )
    return { threads: next, value: next.length !== threads.length }
  })
  return NextResponse.json({ removed })
}
