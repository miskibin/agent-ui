import { NextResponse } from "next/server"

import {
  deleteSession,
  getSession,
  patchSession,
  readMessages,
  writeMessages,
} from "@/lib/store/sessions"
import type { SessionPatch, StoredMessage } from "@/lib/store/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** One thread's messages, loaded only when the thread is opened. */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 })
  }
  return NextResponse.json({ session, messages: await readMessages(id) })
}

/**
 * Rename, pin, reorder and per-chat settings (working folder, branch, the
 * provider-side conversation id). `order` moves the row to that sidebar index.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  let body: SessionPatch
  try {
    body = (await req.json()) as SessionPatch
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const session = await patchSession(id, {
    title: typeof body.title === "string" ? body.title : undefined,
    pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
    order: typeof body.order === "number" ? body.order : undefined,
    providerId: typeof body.providerId === "string" ? body.providerId : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    // "" resets it — that is what `/clear` sends to drop the provider thread.
    providerSessionId:
      typeof body.providerSessionId === "string"
        ? body.providerSessionId
        : undefined,
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    gitBranch: typeof body.gitBranch === "string" ? body.gitBranch : undefined,
  })
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 })
  }
  return NextResponse.json({ session })
}

/**
 * Replaces the stored transcript — how the client persists an inline edit or
 * a deleted turn. Streaming turns are written by `app/api/chat` instead.
 */
export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  let body: { messages?: StoredMessage[] }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  if (!Array.isArray(body.messages)) {
    return NextResponse.json({ error: "messages is required" }, { status: 400 })
  }
  const session = await writeMessages(id, body.messages)
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 })
  }
  return NextResponse.json({ session })
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  const deleted = await deleteSession(id)
  if (!deleted) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 })
  }
  return NextResponse.json({ deleted: true })
}
