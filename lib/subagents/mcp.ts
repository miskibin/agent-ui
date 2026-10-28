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

/**
 * The longest any one call blocks. A call that waits longer than this is
 * answered "still running" and the caller asks again — because the clients
 * give up first: Node's `fetch`, which `agent-ui mcp` proxies through, drops a
 * request that has sent no headers after 300s and reports only "fetch failed",
 * so a 900s wait came back as "Agent UI is not reachable" while the app was
 * fine. Every wait in this vocabulary is therefore a *slice*, and a long wait
 * is a loop of them.
 */
export const MAX_WAIT_SECONDS = 240
/** What a blocking call waits by default — one whole slice. */
export const DEFAULT_WAIT_SECONDS = MAX_WAIT_SECONDS
/** Characters of a final answer returned unless the caller asks for more. */
export const DEFAULT_ANSWER_CHARS = 4000
/** Per run, in a `wait_subagents` answer — it can hold many runs at once. */
export const DEFAULT_WAIT_ANSWER_CHARS = 1500
export const MAX_ANSWER_CHARS = 100_000

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

/** How much a digest says — see `lib/subagents/progress`. */
export type ViewArgs = {
  detail: "brief" | "full"
  sinceStep?: number
  maxAnswerChars: number
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
  /** Stop the run after this long; its chat and partial work are kept. */
  timeoutSeconds?: number
  view: ViewArgs
}

/** A run or a chat, named either way — a chat id survives an app restart. */
export type SubagentRef = { runId?: string; sessionId?: string }

export type MessageSubagentArgs = SubagentRef & {
  message: string
  /** Stop the turn in flight and send this now, instead of after it. */
  interrupt: boolean
  background: boolean
  waitSeconds: number
  timeoutSeconds?: number
  view: ViewArgs
}

export type WaitSubagentsArgs = {
  /** Empty: every run this caller has in flight. */
  runIds: string[]
  mode: "any" | "all"
  waitSeconds: number
  view: ViewArgs
}

/** What the tool handlers need from the server; injected so tests can fake it. */
export type SubagentTools = {
  listHarnesses(): Promise<Record<string, unknown>[]>
  listModels(harness: string): Promise<Record<string, unknown>[]>
  run(args: RunSubagentArgs): Promise<Record<string, unknown>>
  message(args: MessageSubagentArgs): Promise<Record<string, unknown>>
  status(ref: SubagentRef, waitSeconds: number, view: ViewArgs): Promise<Record<string, unknown>>
  wait(args: WaitSubagentsArgs): Promise<Record<string, unknown>>
  cancel(runId: string): Promise<Record<string, unknown>>
  list(): Promise<Record<string, unknown>[]>
}

/*
 * Every description below is paid for in the orchestrator's context on every
 * turn it holds these tools, so they say what a call does and what to pass,
 * and stop.
 */
const VIEW_PROPERTIES = {
  detail: {
    type: "string",
    enum: ["brief", "full"],
    description: "brief (default): status and counters. full: adds the step log and the latest output.",
  },
  since_step: {
    type: "number",
    description: "Return only log steps after this number — pass the `steps` value from your last check.",
  },
  max_answer_chars: {
    type: "number",
    description: `Cap on the final answer (default ${DEFAULT_ANSWER_CHARS}).`,
  },
} as const

const WAIT_DESCRIPTION = `Seconds to block before answering anyway (max ${MAX_WAIT_SECONDS}; call again to keep waiting).`

export const TOOL_DEFINITIONS = [
  {
    name: "list_harnesses",
    description:
      "Agent harnesses this app can run as subagents (pi, codex, cursor, ollama, ACP agents…) and whether each is available. Call before run_subagent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_models",
    description: "Models one harness offers, for run_subagent's `model`.",
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
      "Runs a task on another harness as a subagent: a real chat in the user's app, in your folder unless `cwd` says otherwise. Blocks until done and returns the answer plus a digest (files edited, commands, test runs, errors). `background: true` returns a run_id at once — start several, then wait_subagents.",
    inputSchema: {
      type: "object",
      properties: {
        harness: { type: "string", description: "Harness id from list_harnesses." },
        prompt: {
          type: "string",
          description: "The complete task. The subagent sees none of your conversation.",
        },
        model: { type: "string", description: "Model id from list_models." },
        cwd: { type: "string", description: "Absolute working folder." },
        title: { type: "string", description: "Short name for the chat." },
        session_id: {
          type: "string",
          description: "Continue this subagent chat instead of starting a new one.",
        },
        background: { type: "boolean", description: "Return a run_id immediately." },
        wait_seconds: { type: "number", description: WAIT_DESCRIPTION },
        timeout_seconds: {
          type: "number",
          description: "Stop the run after this long. Its chat and partial work are kept.",
        },
        ...VIEW_PROPERTIES,
      },
      required: ["harness", "prompt"],
    },
  },
  {
    name: "get_subagent",
    description:
      "A subagent's status. Running: phase, what it is doing now, idle_seconds (a stall shows here), waiting_on_user, files edited, commands, test runs, errors. Finished: the answer too. Pass `since_step` to get only new log lines.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        session_id: {
          type: "string",
          description: "Instead of run_id: the chat's latest turn (works after an app restart).",
        },
        wait_seconds: { type: "number", description: WAIT_DESCRIPTION },
        ...VIEW_PROPERTIES,
      },
    },
  },
  {
    name: "wait_subagents",
    description:
      "Blocks until any (default) or all of the given runs finish, then returns a brief status for each. No run_ids: every run you have in flight.",
    inputSchema: {
      type: "object",
      properties: {
        run_ids: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["any", "all"] },
        wait_seconds: { type: "number", description: WAIT_DESCRIPTION },
        max_answer_chars: {
          type: "number",
          description: `Cap on each run's answer (default ${DEFAULT_WAIT_ANSWER_CHARS}); get_subagent reads one in full.`,
        },
      },
    },
  },
  {
    name: "message_subagent",
    description:
      "Sends a follow-up to a subagent's chat: steer it, correct it, or give it the next task. If it is still running the message is queued behind the current turn, or sent at once with `interrupt: true` (the turn in flight is stopped, its work kept). Blocks like run_subagent unless `background`.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        session_id: { type: "string" },
        message: { type: "string" },
        interrupt: { type: "boolean" },
        background: { type: "boolean" },
        wait_seconds: { type: "number", description: WAIT_DESCRIPTION },
        timeout_seconds: { type: "number" },
        ...VIEW_PROPERTIES,
      },
      required: ["message"],
    },
  },
  {
    name: "cancel_subagent",
    description: "Stops a running or queued subagent run. Its chat and partial work are kept.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
  {
    name: "list_subagents",
    description: "Your subagent runs, newest first, one compact row each.",
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

function positive(value: unknown, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(Math.floor(n), max)
}

/** Reads `detail`, `since_step` and `max_answer_chars`. */
export function parseView(raw: unknown): ViewArgs {
  const args = record(raw)
  const step = Number(args.since_step ?? args.sinceStep)
  return {
    detail: args.detail === "full" ? "full" : "brief",
    ...(Number.isFinite(step) && step >= 0 ? { sinceStep: Math.floor(step) } : null),
    maxAnswerChars:
      positive(args.max_answer_chars ?? args.maxAnswerChars, MAX_ANSWER_CHARS) ??
      DEFAULT_ANSWER_CHARS,
  }
}

/** A day: long enough for any real task, short enough to never be forever. */
const MAX_TIMEOUT_SECONDS = 86_400

/** Validates `run_subagent`'s arguments; a string is the reason they fail. */
export function parseRunArgs(raw: unknown): RunSubagentArgs | string {
  const args = record(raw)
  const harness = text(args.harness, 100)
  if (!harness) return "`harness` is required — call list_harnesses for the ids."
  const prompt = text(args.prompt)
  if (!prompt) return "`prompt` is required."
  const timeoutSeconds = positive(args.timeout_seconds ?? args.timeoutSeconds, MAX_TIMEOUT_SECONDS)
  return {
    harness,
    prompt,
    model: text(args.model, 300),
    cwd: text(args.cwd, 4096),
    title: text(args.title, 120),
    sessionId: text(args.session_id ?? args.sessionId, 64),
    background: args.background === true,
    waitSeconds: seconds(args.wait_seconds ?? args.waitSeconds, DEFAULT_WAIT_SECONDS),
    ...(timeoutSeconds ? { timeoutSeconds } : null),
    view: parseView(args),
  }
}

function parseRef(args: Record<string, unknown>): SubagentRef | string {
  const runId = text(args.run_id ?? args.runId, 64)
  const sessionId = text(args.session_id ?? args.sessionId, 64)
  if (!runId && !sessionId) return "`run_id` or `session_id` is required."
  return { ...(runId ? { runId } : null), ...(sessionId ? { sessionId } : null) }
}

export function parseMessageArgs(raw: unknown): MessageSubagentArgs | string {
  const args = record(raw)
  const ref = parseRef(args)
  if (typeof ref === "string") return ref
  const message = text(args.message ?? args.prompt)
  if (!message) return "`message` is required."
  const timeoutSeconds = positive(args.timeout_seconds ?? args.timeoutSeconds, MAX_TIMEOUT_SECONDS)
  return {
    ...ref,
    message,
    interrupt: args.interrupt === true,
    background: args.background === true,
    waitSeconds: seconds(args.wait_seconds ?? args.waitSeconds, DEFAULT_WAIT_SECONDS),
    ...(timeoutSeconds ? { timeoutSeconds } : null),
    view: parseView(args),
  }
}

export function parseWaitArgs(raw: unknown): WaitSubagentsArgs {
  const args = record(raw)
  const ids = Array.isArray(args.run_ids ?? args.runIds)
    ? ((args.run_ids ?? args.runIds) as unknown[])
    : []
  return {
    runIds: ids
      .map((id) => text(id, 64))
      .filter((id): id is string => !!id)
      .slice(0, 50),
    mode: args.mode === "all" ? "all" : "any",
    waitSeconds: seconds(args.wait_seconds ?? args.waitSeconds, DEFAULT_WAIT_SECONDS),
    view: {
      detail: "brief",
      maxAnswerChars:
        positive(args.max_answer_chars ?? args.maxAnswerChars, MAX_ANSWER_CHARS) ??
        DEFAULT_WAIT_ANSWER_CHARS,
    },
  }
}

/**
 * The text half is compact JSON: indentation is a tenth of the tokens of a
 * digest and the model reads it no better for it.
 */
export function toolResult(data: unknown, isError = false): ToolResult {
  const body = typeof data === "string" ? data : JSON.stringify(data)
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
      case "message_subagent": {
        const parsed = parseMessageArgs(args)
        if (typeof parsed === "string") return toolResult(parsed, true)
        const result = await tools.message(parsed)
        return toolResult(result, result.status === "error")
      }
      case "get_subagent": {
        const ref = parseRef(args)
        if (typeof ref === "string") return toolResult(ref, true)
        return toolResult(
          await tools.status(ref, seconds(args.wait_seconds ?? args.waitSeconds, 0), parseView(args))
        )
      }
      case "wait_subagents":
        return toolResult(await tools.wait(parseWaitArgs(args)))
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

const SUBAGENT_INSTRUCTIONS =
  "Run other agent harnesses as subagents; each run is a chat in the user's Agent UI app that they can watch live. Call list_harnesses first. For parallel work start runs with background: true and collect them with wait_subagents; poll get_subagent with since_step for only what is new; steer a run with message_subagent."

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
          ? `${SUBAGENT_INSTRUCTIONS} Keep the user's persistent memory with the memory_* tools.`
          : SUBAGENT_INSTRUCTIONS,
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
