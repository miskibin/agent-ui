import { NextResponse } from "next/server"

import { askNote, cancelNoteAsk } from "@/lib/notes/runs"
import { updateThreads } from "@/lib/notes/server"
import { crossOriginRefusal } from "@/lib/request-origin"
import { rememberOrigin, requestOrigin } from "@/lib/subagents/bridge"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

type AskBody = {
  threadId?: unknown
  anchor?: unknown
  instruction?: unknown
  providerId?: unknown
  model?: unknown
  effort?: unknown
}

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

/**
 * Asks the note's agent to do something with the selected words: starts a
 * thread on them (or continues `threadId`) and runs the turn in the
 * background. The page follows it on `/events`.
 */
export async function POST(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  let body: AskBody
  try {
    body = (await req.json()) as AskBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const providerId = text(body.providerId, 100)
  if (!providerId) return NextResponse.json({ error: "Pick an agent first." }, { status: 400 })
  const origin = requestOrigin(req)
  void rememberOrigin(origin)
  try {
    const threadId = await askNote({
      origin,
      noteId: id,
      threadId: text(body.threadId, 64) || undefined,
      anchor: typeof body.anchor === "string" ? body.anchor : "",
      instruction: text(body.instruction, 8000),
      providerId,
      model: text(body.model, 300),
      effort: text(body.effort, 40) || undefined,
    })
    return NextResponse.json({ threadId })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}

/** Stops the ask on `?thread=` — the running one, or one still waiting. */
export async function DELETE(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  const threadId = new URL(req.url).searchParams.get("thread") ?? ""
  if (cancelNoteAsk(id, threadId || undefined)) return NextResponse.json({ cancelled: true })
  const cancelled = await updateThreads(id, (threads) => {
    let hit = false
    const next = threads.map((thread) => {
      if (thread.id !== threadId || thread.status !== "queued") return thread
      hit = true
      return { ...thread, status: "cancelled" as const, updatedAt: Date.now() }
    })
    return { threads: next, value: hit }
  })
  return NextResponse.json({ cancelled })
}
