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
  harnessList,
  harnessModels,
  listRuns,
  startRun,
  waitForRun,
} from "@/lib/subagents/runs"
import { isValidSessionId } from "@/lib/store/sessions"
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
      })
      if (args.background) {
        return {
          run_id: run.runId,
          session_id: run.sessionId,
          status: run.status,
          note: "Started in the background. Collect it with get_subagent.",
        }
      }
      await waitForRun(run.runId, args.waitSeconds)
      return describeRun(run.runId)
    },
    async status(runId, waitSeconds) {
      await waitForRun(runId, waitSeconds)
      return describeRun(runId)
    },
    async cancel(runId) {
      return { run_id: runId, cancelled: cancelRun(runId) }
    },
    async list() {
      return listRuns(parentId).map((run) => ({
        run_id: run.runId,
        session_id: run.sessionId,
        harness: run.harness,
        title: run.title,
        status: run.status,
      }))
    },
  }

  const answer = await handleRpc(message, tools, packageJson.version)
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
