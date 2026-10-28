import { NextResponse } from "next/server"

import { forgetBackground } from "@/lib/background-processes"
import { deleteCheckpointRefs } from "@/lib/checkpoints"
import { crossOriginRefusal } from "@/lib/request-origin"
import { regenerateSessionTitle } from "@/lib/session-title"
import {
  deleteSession,
  getSession,
  normalizeWorktree,
  patchSession,
  readLifecyclePatch,
  readMessages,
  writeMessages,
} from "@/lib/store/sessions"
import type { SessionPatch, StoredMessage } from "@/lib/store/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/**
 * Asks a model to (re)name the chat. It lives on this route rather than a
 * nested `/title` one: that was the only route under a dynamic segment, and
 * some dev servers answered it with Next's own 404 page.
 */
export async function POST(req: Request, ctx: Ctx) {
  // A model call on the user's key, from a page on another origin — no.
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  return regenerateSessionTitle(id)
}

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
 * worktree it was started in, the provider-side conversation id) plus the
 * chat's lifecycle — settled, snoozed, woken, visited. `order` moves the row
 * to that sidebar index.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
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
    // Set when a chat moves into a worktree the picker just made for it.
    worktree: normalizeWorktree(body.worktree),
    // Settle / snooze / wake / visit — see `lib/session-lifecycle`. A patch
    // carrying only these leaves `updatedAt` where it was.
    ...readLifecyclePatch(body),
    // "" clears it — the chat falls back to the harness's configured policy.
    permissionMode:
      typeof body.permissionMode === "string" ? body.permissionMode : undefined,
    // Taking over a chat an outside agent started; there is no way back in.
    external: body.external === false ? false : undefined,
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
  const refused = crossOriginRefusal(req)
  if (refused) return refused
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

export async function DELETE(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  /**
   * The chat's checkpoints are refs in the *user's* repository, and the
   * commits they point at are only unreachable once the refs are gone — so a
   * deleted conversation would otherwise leave every worktree it passed
   * through pinned forever. Done before the session record goes, because that
   * record is the only thing that knows which folder they are in, and never
   * allowed to fail the delete: a chat the user asked to remove is removed.
   */
  const session = await getSession(id)
  const cwd = session?.cwd?.trim()
  if (cwd) {
    await deleteCheckpointRefs(cwd, id).catch(() => {
      /* refs the user can prune themselves; the chat still goes */
    })
  }
  // What its agents left running keeps running — it is the user's to stop —
  // but no longer belongs to a chat that exists.
  await forgetBackground(id).catch(() => undefined)
  const deleted = await deleteSession(id)
  if (!deleted) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 })
  }
  return NextResponse.json({ deleted: true })
}
