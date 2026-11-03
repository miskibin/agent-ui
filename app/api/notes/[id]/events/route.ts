import { getNoteMeta, subscribeNote } from "@/lib/notes/server"
import { isValidNoteId } from "@/lib/notes/types"
import { crossOriginRefusal } from "@/lib/request-origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

const KEEPALIVE_MS = 25_000

/**
 * The open note's window onto other writers: a frame each time the content
 * gets a new revision (an agent's edit, a restore, another window's save) or
 * its threads change. Frames carry no content — the page fetches the note
 * when it hears of a rev it does not have.
 */
export async function GET(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  if (!isValidNoteId(id) || !(await getNoteMeta(id))) {
    return Response.json({ error: "Note not found" }, { status: 404 })
  }
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
      send(": connected\n\n")
      const unsubscribe = subscribeNote(id, (event) => send(`data: ${JSON.stringify(event)}\n\n`))
      const keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS)
      cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(keepalive)
        unsubscribe()
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
