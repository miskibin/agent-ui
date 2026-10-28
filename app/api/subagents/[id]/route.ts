import { NextResponse } from "next/server"

import { crossOriginRefusal } from "@/lib/request-origin"
import { cancelRun, describeRun } from "@/lib/subagents/runs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  try {
    return NextResponse.json(describeRun(id))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "No such run" },
      { status: 404 }
    )
  }
}

/** Stop pressed on a subagent chat: the run ends, its chat stays. */
export async function DELETE(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  return NextResponse.json({ cancelled: cancelRun(id) })
}
