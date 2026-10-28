import { crossOriginRefusal } from "@/lib/request-origin"
import { rememberOrigin, requestOrigin } from "@/lib/subagents/bridge"
import { listRuns, watchSubagents } from "@/lib/subagents/runs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Comment lines keep the connection from looking idle to anything between. */
const KEEPALIVE_MS = 25_000

/**
 * The page's window onto subagent runs: a snapshot of what is running when it
 * connects, then every run that starts or ends. The page attaches to each run
 * it hears of (`/api/subagents/<id>/stream`), which is what puts a chat it
 * never sent anything in into the sidebar, working, and live when opened.
 */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  // The page reaching us is the most reliable word on which port we are on.
  void rememberOrigin(requestOrigin(req))

  const encoder = new TextEncoder()
  let cleanup = () => {}
  const stream = new ReadableStream({
    start(controller) {
      let closed = false
      const send = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          closed = true
        }
      }
      send(`data: ${JSON.stringify({ type: "snapshot", runs: listRuns() })}\n\n`)
      const unwatch = watchSubagents((event) => {
        send(`data: ${JSON.stringify(event)}\n\n`)
      })
      const keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS)
      cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(keepalive)
        unwatch()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
      req.signal.addEventListener("abort", () => cleanup())
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
