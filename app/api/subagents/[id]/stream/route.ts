import { NextResponse } from "next/server"

import { crossOriginRefusal } from "@/lib/request-origin"
import { subscribeRun } from "@/lib/subagents/runs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/**
 * One subagent run as the page would have received it from `/api/chat`:
 * every frame so far, then the rest live, then `[DONE]`. Same framing, so
 * `lib/api-client` reads it with the reader it uses for any turn. Closing the
 * connection only stops watching — `DELETE /api/subagents/<id>` stops the run.
 */
export async function GET(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params

  const encoder = new TextEncoder()
  let cleanup = () => {}
  let found = true
  const stream = new ReadableStream({
    start(controller) {
      let closed = false
      const end = () => {
        if (closed) return
        closed = true
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        } catch {
          /* client already gone */
        }
      }
      const send = (frame: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${frame}\n\n`))
        } catch {
          closed = true
        }
      }
      const subscription = subscribeRun(id, (frame) => {
        if (frame === null) end()
        else send(frame)
      })
      if (!subscription) {
        found = false
        end()
        return
      }
      for (const frame of subscription.frames) send(frame)
      if (subscription.done) end()
      cleanup = () => {
        subscription.unsubscribe()
        closed = true
      }
      req.signal.addEventListener("abort", () => cleanup())
    },
    cancel() {
      cleanup()
    },
  })

  if (!found) {
    return NextResponse.json({ error: "No such subagent run" }, { status: 404 })
  }
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
