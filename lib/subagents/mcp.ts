/**
 * The app's MCP surface: the tools an agent running in one of this app's
 * chats — Claude Code first — calls to hand work to *another* harness (pi,
 * tinyagent, codex, cursor, ollama…) as a subagent.
 *
 * Why a bridge at all, rather than letting the agent shell out to `pi` or
 * `codex` itself: a subagent started here runs through the app's own chat
 * route, so it is a real chat — persisted, resumable, journalled, listed under
 * the chat that started it and streaming live in the window — instead of a
 * subprocess whose work vanishes into one tool result.
 *
 * This module is the pure half: the tool vocabulary, argument validation and
 * the JSON-RPC envelope of MCP's Streamable HTTP transport (POST one message,
 * get one JSON answer). It imports nothing `node --test` cannot load;
 * `lib/subagents/runs.ts` owns the processes and `app/api/mcp/route.ts` wires
 * the two together.
 */

import {
  callMemoryTool,
  MEMORY_TOOL_DEFINITIONS,
  MEMORY_TOOL_NAMES,
  type MemoryTools,
} from "@/lib/memory/tools"

export const MCP_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const

export const MCP_SERVER_NAME = "agent-ui"

/** What a blocking `run_subagent` waits by default before it answers anyway. */
export const DEFAULT_WAIT_SECONDS = 600
export const MAX_WAIT_SECONDS = 3600

export type JsonRpcId = string | number

export type JsonRpcMessage = {
  jsonrpc?: string
  id?: JsonRpcId | null
  method?: string
  params?: unknown
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId | null; result: unknown }
  | {
      jsonrpc: "2.0"
      id: JsonRpcId | null
      error: { code: number; message: string }
    }

export type ToolResult = {
  content: { type: "text"; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type RunSubagentArgs = {
  harness: string
  prompt: string
  model?: string
  cwd?: string
  title?: string
  /** Continue an existing subagent chat instead of starting a new one. */
  sessionId?: string
  background: boolean
  waitSeconds: number
}

/** What the tool handlers need from the server; injected so tests can fake it. */
export type SubagentTools = {
  listHarnesses(): Promise<Record<string, unknown>[]>
  listModels(harness: string): Promise<Record<string, unknown>[]>
  run(args: RunSubagentArgs): Promise<Record<string, unknown>>
  status(runId: string, waitSeconds: number): Promise<Record<string, unknown>>
  cancel(runId: string): Promise<Record<string, unknown>>
  list(): Promise<Record<string, unknown>[]>
}

export const TOOL_DEFINITIONS = [
  {
    name: "list_harnesses",
    description:
      "Lists the agent harnesses this app can run as subagents (e.g. pi, codex, cursor, ollama, tinyagent and other ACP agents), with whether each is available right now. Call this before run_subagent to pick a harness id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_models",
    description:
      "Lists the models one harness offers. Model ids are passed to run_subagent as `model`; omit it there to use the harness's default.",
    inputSchema: {
      type: "object",
      properties: {
        harness: { type: "string", description: "Harness id from list_harnesses." },
      },
      required: ["harness"],
    },
  },
  {
    name: "run_subagent",
    description:
      "Runs a prompt on another agent harness as a subagent. The subagent is a full chat in the user's app (listed under this chat, streaming live, resumable later) working in the same folder as you unless `cwd` says otherwise. By default this blocks until the subagent finishes and returns its final answer. Set `background: true` to start several in parallel and collect them with get_subagent. Pass `session_id` from an earlier result to continue that subagent's conversation.",
    inputSchema: {
      type: "object",
      properties: {
        harness: { type: "string", description: "Harness id from list_harnesses." },
        prompt: {
          type: "string",
          description:
            "The complete task. The subagent sees nothing of your conversation, so include every detail it needs.",
        },
        model: { type: "string", description: "Model id from list_models. Optional." },
        cwd: {
          type: "string",
          description: "Absolute working folder. Defaults to this chat's folder.",
        },
        title: { type: "string", description: "Short name for the subagent chat." },
        session_id: {
          type: "string",
          description: "Continue this earlier subagent chat instead of starting a new one.",
        },
        background: {
          type: "boolean",
          description: "Return immediately with a run_id instead of waiting.",
        },
        wait_seconds: {
          type: "number",
          description: `How long to wait before answering with the run still in progress (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}). Ignored with background.`,
        },
      },
      required: ["harness", "prompt"],
    },
  },
  {
    name: "get_subagent",
    description:
      "Status of a subagent run: running, done, error or cancelled, its final answer once done, and the latest output while it runs. `wait_seconds` waits up to that long for it to finish first.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        wait_seconds: { type: "number" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "cancel_subagent",
    description: "Stops a running subagent. Its chat and partial work are kept.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
  {
    name: "list_subagents",
    description: "Subagent runs started from this chat, newest first.",
    inputSchema: { type: "object", properties: {} },
  },
] as const

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown, max = 200_000): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function seconds(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(Math.floor(n), MAX_WAIT_SECONDS)
}

/** Validates `run_subagent`'s arguments; a string is the reason they fail. */
export function parseRunArgs(raw: unknown): RunSubagentArgs | string {
  const args = record(raw)
  const harness = text(args.harness, 100)
  if (!harness) return "`harness` is required — call list_harnesses for the ids."
  const prompt = text(args.prompt)
  if (!prompt) return "`prompt` is required."
  return {
    harness,
    prompt,
    model: text(args.model, 300),
    cwd: text(args.cwd, 4096),
    title: text(args.title, 120),
    sessionId: text(args.session_id ?? args.sessionId, 64),
    background: args.background === true,
    waitSeconds: seconds(args.wait_seconds ?? args.waitSeconds, DEFAULT_WAIT_SECONDS),
  }
}

export function toolResult(data: unknown, isError = false): ToolResult {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2)
  return {
    content: [{ type: "text", text: body }],
    ...(data && typeof data === "object" && !Array.isArray(data)
      ? { structuredContent: data as Record<string, unknown> }
      : null),
    ...(isError ? { isError: true } : null),
  }
}

/** One `tools/call`. Failures are tool errors the model can read, never throws. */
export async function callTool(
  tools: SubagentTools,
  name: string,
  rawArgs: unknown
): Promise<ToolResult> {
  const args = record(rawArgs)
  try {
    switch (name) {
      case "list_harnesses":
        return toolResult({ harnesses: await tools.listHarnesses() })
      case "list_models": {
        const harness = text(args.harness, 100)
        if (!harness) return toolResult("`harness` is required.", true)
        return toolResult({ harness, models: await tools.listModels(harness) })
      }
      case "run_subagent": {
        const parsed = parseRunArgs(args)
        if (typeof parsed === "string") return toolResult(parsed, true)
        const result = await tools.run(parsed)
        return toolResult(result, result.status === "error")
      }
      case "get_subagent": {
        const runId = text(args.run_id ?? args.runId, 64)
        if (!runId) return toolResult("`run_id` is required.", true)
        return toolResult(await tools.status(runId, seconds(args.wait_seconds, 0)))
      }
      case "cancel_subagent": {
        const runId = text(args.run_id ?? args.runId, 64)
        if (!runId) return toolResult("`run_id` is required.", true)
        return toolResult(await tools.cancel(runId))
      }
      case "list_subagents":
        return toolResult({ runs: await tools.list() })
      default:
        return toolResult(`Unknown tool "${name}".`, true)
    }
  } catch (err) {
    return toolResult(err instanceof Error ? err.message : String(err), true)
  }
}

function ok(id: JsonRpcId | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result }
}

function fail(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

/**
 * Answers one JSON-RPC message. `null` is a notification, which gets no body
 * (the route answers 202).
 */
export async function handleRpc(
  message: JsonRpcMessage,
  tools: SubagentTools,
  version = "0.0.0",
  /** The user's memory, offered only while memory is on (`lib/memory/tools`). */
  memory?: MemoryTools
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null
  const method = typeof message.method === "string" ? message.method : ""
  if (message.id === undefined || message.id === null) {
    // `notifications/initialized`, `notifications/cancelled`… nothing to say.
    return null
  }
  if (message.jsonrpc !== "2.0" || !method) {
    return fail(id, -32600, "Invalid request")
  }
  const params = record(message.params)
  switch (method) {
    case "initialize": {
      const asked = text(params.protocolVersion, 40)
      const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(
        asked as (typeof MCP_PROTOCOL_VERSIONS)[number]
      )
        ? asked
        : MCP_PROTOCOL_VERSIONS[0]
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version },
        instructions: memory
          ? "Run other agent harnesses as subagents (each run is a chat in the user's Agent UI app that they can watch live; call list_harnesses first), and keep the user's persistent memory with the memory_* tools."
          : "Run other agent harnesses as subagents. Each run is a chat in the user's Agent UI app that they can watch live. Call list_harnesses first.",
      })
    }
    case "ping":
      return ok(id, {})
    case "tools/list":
      return ok(id, {
        tools: memory ? [...TOOL_DEFINITIONS, ...MEMORY_TOOL_DEFINITIONS] : TOOL_DEFINITIONS,
      })
    case "tools/call": {
      const name = text(params.name, 100)
      if (!name) return fail(id, -32602, "Missing tool name")
      if (MEMORY_TOOL_NAMES.has(name)) {
        if (!memory) return ok(id, toolResult("Memory is turned off in this app's settings.", true))
        const answer = await callMemoryTool(memory, name, record(params.arguments))
        return ok(id, toolResult(answer.data, answer.isError))
      }
      return ok(id, await callTool(tools, name, params.arguments))
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`)
  }
}
