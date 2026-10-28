import { NextResponse } from "next/server"

import { crossOriginRefusal } from "@/lib/request-origin"
import {
  authorized,
  rememberOrigin,
  requestOrigin,
} from "@/lib/subagents/bridge"
import {
  handleRpc,
  type JsonRpcMessage,
  type SubagentTools,
} from "@/lib/subagents/mcp"
import {
  cancelRun,
  describeRun,
  describeSession,
  harnessList,
  harnessModels,
  inFlightRuns,
  listRunRows,
  messageSubagent,
  startRun,
  waitForRun,
  waitForRuns,
} from "@/lib/subagents/runs"
import { isValidSessionId } from "@/lib/store/sessions"
import {
  deleteMemoryFile,
  readMemoryFiles,
  writeMemoryFile,
} from "@/lib/memory/server"
import type { MemoryTools } from "@/lib/memory/tools"
import { readSettings } from "@/lib/settings/server"
import packageJson from "@/package.json"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The subagent bridge, as an MCP server (Streamable HTTP, JSON answers, no
 * server-initiated stream). A harness this app spawns is handed it with
 * `?parent=<chat>&mode=<permission>`; one the user wired up themselves
 * (`bin/agent-ui.mjs mcp-config`) has no parent and its subagents are
 * top-level chats.
 */
export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "Missing or wrong bridge token" }, { status: 401 })
  }

  let message: JsonRpcMessage
  try {
    message = (await req.json()) as JsonRpcMessage
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 }
    )
  }
  if (Array.isArray(message)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches are not supported" } },
      { status: 400 }
    )
  }

  const url = new URL(req.url)
  const parentParam = url.searchParams.get("parent") ?? ""
  const parentId = isValidSessionId(parentParam) ? parentParam : undefined
  const permissionMode = url.searchParams.get("mode")?.trim() || undefined
  const origin = requestOrigin(req)
  void rememberOrigin(origin)

  const tools: SubagentTools = {
    listHarnesses: harnessList,
    listModels: harnessModels,
    async run(args) {
      const run = await startRun({
        origin,
        harness: args.harness,
        prompt: args.prompt,
        model: args.model,
        cwd: args.cwd,
        title: args.title,
        sessionId: args.sessionId,
        parentId,
        permissionMode,
        timeoutSeconds: args.timeoutSeconds,
      })
      if (!args.background) await waitForRun(run.runId, args.waitSeconds)
      return describeRun(run.runId, args.view)
    },
    async message(args) {
      const run = await messageSubagent({
        origin,
        runId: args.runId,
        sessionId: args.sessionId,
        message: args.message,
        interrupt: args.interrupt,
        parentId,
        permissionMode,
        timeoutSeconds: args.timeoutSeconds,
      })
      if (!args.background) await waitForRun(run.runId, args.waitSeconds)
      return describeRun(run.runId, args.view)
    },
    async status(ref, waitSeconds, view) {
      if (ref.runId) {
        await waitForRun(ref.runId, waitSeconds)
        try {
          return describeRun(ref.runId, view)
        } catch (err) {
          // A run id the registry lost (an app restart) still names a chat
          // when the caller passed both; fall back to reading that.
          if (!ref.sessionId) throw err
        }
      }
      return describeSession(ref.sessionId!, view)
    },
    async wait(args) {
      const ids = args.runIds.length ? args.runIds : inFlightRuns(parentId)
      if (ids.length === 0) return { runs: [], note: "Nothing in flight." }
      await waitForRuns(ids, args.mode, args.waitSeconds)
      const runs = ids.map((id) => {
        try {
          return describeRun(id, args.view)
        } catch (err) {
          return { run_id: id, status: "unknown", error: err instanceof Error ? err.message : String(err) }
        }
      })
      const open = runs.filter((run) => run.status === "running" || run.status === "queued").length
      return { runs, ...(open ? { still_running: open } : null) }
    },
    async cancel(runId) {
      return { run_id: runId, cancelled: cancelRun(runId) }
    },
    async list() {
      return listRunRows(parentId)
    },
  }

  // Read per message, so switching memory off takes the tools away at once.
  const memory: MemoryTools | undefined = (await readSettings()).memory.enabled
    ? { list: readMemoryFiles, write: writeMemoryFile, remove: deleteMemoryFile }
    : undefined

  const answer = await handleRpc(message, tools, packageJson.version, memory)
  if (!answer) return new Response(null, { status: 202 })
  return NextResponse.json(answer)
}

/** No server-initiated stream: every answer rides its own POST. */
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } })
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } })
}
