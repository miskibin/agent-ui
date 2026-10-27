import { NextResponse } from "next/server"

import { listBackground, stopBackground } from "@/lib/background-processes"
import { discoverDevServers } from "@/lib/dev-servers"
import { descendantsOf } from "@/lib/process-list"
import { scanProcesses } from "@/lib/process-scan"
import { crossOriginRefusal } from "@/lib/request-origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/processes?sessionId=…` — what the chat's agents left running
 * (`lib/background-processes`), still running now. Without a `sessionId`,
 * every chat's.
 *
 * A row that is serving a page carries its `url`: a dev server is matched to
 * the listener whose pid is the process or one of its children, where the
 * platform reports listener pids at all.
 */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const sessionId = new URL(req.url).searchParams.get("sessionId")?.trim() || undefined

  const processes = await listBackground(sessionId)
  if (processes.length === 0) return NextResponse.json({ processes })

  const ownPort = Number.parseInt((req.headers.get("host") ?? "").split(":")[1] ?? "", 10)
  const [servers, procs] = await Promise.all([
    discoverDevServers(Number.isInteger(ownPort) ? { exclude: [ownPort] } : {}).catch(
      () => []
    ),
    scanProcesses(),
  ])
  const withUrls = processes.map((entry) => {
    const tree = new Set([entry.pid, ...descendantsOf(procs, entry.pid).map((p) => p.pid)])
    const server = servers.find((item) => item.pid !== undefined && tree.has(item.pid))
    return server ? { ...entry, url: server.url } : entry
  })
  return NextResponse.json({ processes: withUrls })
}

/**
 * `DELETE /api/processes?sessionId=…&pid=…` — stops one of the chat's
 * processes and everything below it; without `pid`, all of them. Only a
 * process this app recorded for that chat can be named.
 */
export async function DELETE(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const params = new URL(req.url).searchParams
  const sessionId = params.get("sessionId")?.trim()
  if (!sessionId) {
    return NextResponse.json({ error: "No chat given" }, { status: 400 })
  }
  const rawPid = params.get("pid")
  const pid = rawPid ? Number(rawPid) : undefined
  if (pid !== undefined && !Number.isInteger(pid)) {
    return NextResponse.json({ error: "Bad pid" }, { status: 400 })
  }
  const stopped = await stopBackground(sessionId, pid)
  return NextResponse.json({ stopped })
}
