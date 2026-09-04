import "server-only"

import { spawn } from "node:child_process"

import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import { resolveAcpCommand, type AcpCommand } from "@/lib/acp-runtime"
import { exitCodeFrom } from "@/lib/providers/exit-code"
import { LineBuffer } from "@/lib/stream-framing"
import {
  ACP_ERROR,
  ACP_PROTOCOL_VERSION,
  AcpRpcError,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpPermissionOption,
  type AcpPromptResult,
  type AcpReadTextFileParams,
  type AcpRequestPermissionParams,
  type AcpSessionNewResult,
  type AcpSessionUpdate,
  type AcpSessionUpdateParams,
  type AcpToolCallContent,
  type AcpWriteTextFileParams,
  type JsonRpcId,
  type JsonRpcMessage,
} from "@/lib/acp-types"

/**
 * A hand-rolled bidirectional JSON-RPC client for ACP agents, and the
 * translation of one prompt turn into `AgentStreamEvent`s.
 *
 * What makes this different from `lib/pi-agent.ts` and `lib/cursor-agent.ts`:
 * those read one JSONL stream and translate it, while an ACP agent also *calls
 * us* mid-turn — `fs/read_text_file`, `fs/write_text_file`,
 * `session/request_permission` — and blocks its own turn until we answer. So
 * the transport has to correlate our outbound requests *and* dispatch inbound
 * ones, over the same pair of pipes.
 *
 * Lifecycle is the same one-process-per-turn shape every other spawn-based
 * provider here uses: spawn, `initialize`, `session/new` or `session/resume`,
 * `session/prompt`, then close and kill in `finally`. That works because ACP
 * session state is persisted by the agent and `session/resume` reconstructs it
 * across process restarts.
 */

const MAX_FIELD = 50_000
/** The handshake is bounded; the turn itself is bounded by the route's abort. */
const HANDSHAKE_MS = 45_000
/** Config options are a refinement of the turn, so they wait much less. */
const CONFIG_MS = 10_000
/** How long a closing agent gets to drain before SIGTERM. */
const SHUTDOWN_MS = 750

export { AcpRpcError }

export type AcpSpawnSpec = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export type AcpToolCallSummary = {
  toolCallId: string
  title?: string
  kind?: string
  rawInput?: unknown
}

export type AcpClientHandlers = {
  /** Absolute path in, file contents out. Throw `AcpRpcError` to refuse. */
  readTextFile(params: { path: string; line?: number; limit?: number }): Promise<string>
  writeTextFile(params: { path: string; content: string }): Promise<void>
  /**
   * Which option to select, or null to pick a rejecting one. Answered from a
   * policy setting — see `lib/providers/acp.ts`. Must not block on a browser
   * round-trip: the agent's turn is stopped until this returns.
   */
  decidePermission(request: {
    toolCall: AcpToolCallSummary
    options: AcpPermissionOption[]
  }): { option: AcpPermissionOption | null; reason: string }
}

export type AcpRunOptions = {
  spawn: AcpSpawnSpec
  prompt: string
  /** Opaque `configOptions` value for the agent's model select; empty to skip. */
  model?: string
  /** Opaque `configOptions` value for reasoning effort; empty to skip. */
  effort?: string
  /** ACP session to resume; absent starts a new one. */
  sessionId?: string
  /** Display name, used in error messages. */
  label: string
  /**
   * Whether `fs/write_text_file` is served this turn. A read-only turn both
   * withholds the capability in the handshake and refuses the call: an agent
   * that asks for the write anyway must not be handed one.
   */
  canWriteFiles: boolean
  handlers: AcpClientHandlers
  signal?: AbortSignal
}

/* -------------------------------------------------------------------------- */
/*                                 transport                                  */
/* -------------------------------------------------------------------------- */

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

type InboundHandler = (method: string, params: unknown) => Promise<unknown>

type AcpConnection = {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  notify(method: string, params?: unknown): void
  onNotification(handler: (method: string, params: unknown) => void): void
  onRequest(handler: InboundHandler): void
  /** The spawn errno, if the process never started. */
  spawnFailure(): NodeJS.ErrnoException | undefined
  stderr(): string
  dispose(): void
}

function connectAcp(spec: AcpSpawnSpec): AcpConnection {
  const command = resolveAcpCommand(spec.command, spec.args)
  // Resolved from settings at runtime, so there is nothing for the bundler to
  // trace — same hint `lib/cursor-agent.ts` and `lib/pi-agent.ts` use.
  const child = spawn(/*turbopackIgnore: true*/ command.cmd, command.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })

  // Decoding per chunk would tear a multi-byte character in half wherever the
  // pipe happened to break; the stream's own decoder holds the tail back until
  // the rest of the sequence arrives.
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")

  const pending = new Map<JsonRpcId, PendingCall>()
  const stderrChunks: string[] = []
  const failure: { error?: NodeJS.ErrnoException } = {}
  let nextId = 0
  let closed = false
  let onNotification: ((method: string, params: unknown) => void) | null = null
  let onRequest: InboundHandler | null = null

  const fail = (reason: Error) => {
    if (closed) return
    closed = true
    for (const call of pending.values()) call.reject(reason)
    pending.clear()
  }

  child.once("error", (err: NodeJS.ErrnoException) => {
    failure.error = err
    fail(new Error(describeSpawnFailure(err, command)))
  })
  child.once("close", () => {
    fail(
      new Error(
        stderrChunks.join("").trim() ||
          `${command.cmd} exited before the turn finished`
      )
    )
  })

  child.stderr?.on("data", (chunk: string) => {
    // Free-form by spec; logged, never parsed.
    if (stderrChunks.length < 64) stderrChunks.push(chunk)
  })

  // A cancel that races the agent's own exit writes into a closed pipe, and an
  // unhandled EPIPE there would take the server down with it.
  child.stdin?.on("error", () => {
    /* the close handler rejects anything still pending */
  })

  const write = (message: unknown) => {
    if (closed || !child.stdin?.writable) return
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      /* the close handler rejects anything still pending */
    }
  }

  // Framing is newline-delimited JSON, split on "\n" only: a generic line
  // reader (Node's `readline` included) also splits on U+2028/U+2029, which are
  // legal inside JSON strings and would tear records apart.
  const lines = new LineBuffer()
  const processLine = (line: string) => {
    const trimmed = line.replace(/\r$/, "").trim()
    if (!trimmed.startsWith("{")) return
    let message: JsonRpcMessage
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage
    } catch {
      return
    }
    dispatch(message)
  }
  child.stdout?.on("data", (chunk: string) => {
    try {
      for (const line of lines.push(chunk)) processLine(line)
    } catch (err) {
      // An over-long record throws out of the framing; this is an event
      // handler, so the only way it reaches the turn is through `fail`.
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
  child.stdout?.once("end", () => {
    const tail = lines.finish()
    if (tail !== null) processLine(tail)
  })

  function dispatch(message: JsonRpcMessage) {
    // A response to us: has an id and no method.
    if (message.id !== undefined && message.method === undefined) {
      const call = pending.get(message.id)
      if (!call) return
      pending.delete(message.id)
      if (message.error) {
        call.reject(
          new AcpRpcError(
            message.error.code,
            message.error.message,
            message.error.data
          )
        )
      } else {
        call.resolve(message.result)
      }
      return
    }
    // A request from the agent: has both an id and a method, and blocks the
    // agent's turn until we write a response back.
    if (message.id !== undefined && message.method) {
      const id = message.id
      const method = message.method
      const handler = onRequest
      const answer = handler
        ? handler(method, message.params)
        : Promise.reject(
            new AcpRpcError(ACP_ERROR.methodNotFound, `Method not found: ${method}`)
          )
      void answer.then(
        (result) => write({ jsonrpc: "2.0", id, result: result ?? null }),
        (err: unknown) => {
          const rpc =
            err instanceof AcpRpcError
              ? { code: rpcCode(err), message: err.message, data: err.data }
              : {
                  code: ACP_ERROR.internalError,
                  message: err instanceof Error ? err.message : String(err),
                }
          write({ jsonrpc: "2.0", id, error: rpc })
        }
      )
      return
    }
    if (message.method) onNotification?.(message.method, message.params)
  }

  return {
    request<T>(method: string, params?: unknown, timeoutMs?: number) {
      if (closed) {
        return Promise.reject(
          new Error(`${command.cmd} is not running (${method})`)
        )
      }
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined
        const settle = (fn: () => void) => {
          if (timer) clearTimeout(timer)
          fn()
        }
        pending.set(id, {
          resolve: (value) => settle(() => resolve(value as T)),
          reject: (reason) => settle(() => reject(reason)),
        })
        if (timeoutMs) {
          timer = setTimeout(() => {
            pending.delete(id)
            reject(
              new Error(
                `${command.cmd} did not answer ${method} within ${Math.round(timeoutMs / 1000)}s — is it an ACP agent?`
              )
            )
          }, timeoutMs)
        }
        write({ jsonrpc: "2.0", id, method, params })
      })
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, params })
    },
    onNotification(handler) {
      onNotification = handler
    },
    onRequest(handler) {
      onRequest = handler
    },
    spawnFailure: () => failure.error,
    stderr: () => stderrChunks.join("").trim(),
    dispose() {
      // Per the transport spec: close stdin, then terminate. Both guarded —
      // the child may already be gone.
      try {
        child.stdin?.end()
      } catch {
        /* already closed */
      }
      const timer = setTimeout(() => {
        if (child.exitCode == null && !child.signalCode) {
          try {
            child.kill("SIGTERM")
          } catch {
            /* already gone */
          }
        }
      }, SHUTDOWN_MS)
      timer.unref?.()
      child.once("close", () => clearTimeout(timer))
    },
  }
}

/** Only JSON-RPC-shaped codes travel back on the wire. */
function rpcCode(err: AcpRpcError): number {
  return Number.isInteger(err.code) ? err.code : ACP_ERROR.internalError
}

function describeSpawnFailure(
  err: NodeJS.ErrnoException,
  command: AcpCommand
): string {
  const target = [command.cmd, ...command.args].join(" ")
  const settings = "Settings → Providers → ACP agents"
  if (err.code === "ENOENT") {
    return `Agent binary not found — tried \`${target}\`. Install it or set its path in ${settings}.`
  }
  if (err.code === "EACCES") {
    return `${command.cmd} is not executable. Check its permissions or point ${settings} elsewhere.`
  }
  if (err.code === "EINVAL" && process.platform === "win32") {
    return `Could not start ${command.cmd}: Node refuses to spawn a .cmd shim directly. Point ${settings} at the .js entry point it wraps.`
  }
  return `Could not start the agent (${err.code ?? "spawn failed"}): ${err.message} — tried \`${target}\``
}

/* -------------------------------------------------------------------------- */
/*                                event queue                                 */
/* -------------------------------------------------------------------------- */

/**
 * Bridges the push-shaped stdout dispatcher to the pull-shaped generator the
 * chat route consumes: notifications land here as they arrive and drain in
 * order, and `finish()` ends the loop once the turn settles.
 */
class EventQueue {
  private items: AgentStreamEvent[] = []
  private wake: (() => void) | null = null
  private done = false

  push(event: AgentStreamEvent) {
    if (this.done) return
    this.items.push(event)
    this.wake?.()
  }

  finish() {
    this.done = true
    this.wake?.()
  }

  async *drain(): AsyncGenerator<AgentStreamEvent> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!
      if (this.done) return
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null
          resolve()
        }
      })
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                              event translation                             */
/* -------------------------------------------------------------------------- */

/**
 * One `session/update` in, zero or more stream events out.
 *
 * `tool_call_update` omits `title` and `kind`, so creations are remembered in
 * `tools` and their titles replayed onto every later patch —
 * `lib/message-stream.ts#upsertToolPart` merges by id, so repeated events on
 * one id refine the same card instead of resetting it.
 */
export function mapAcpUpdate(
  params: unknown,
  tools: Map<string, AcpToolCallSummary>
): AgentStreamEvent[] {
  const update = (params as AcpSessionUpdateParams | undefined)?.update
  if (!update) return []

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      // Despite the name these are committed messages, not token deltas: dsh
      // delivers a whole answer as one chunk at turn end.
      const text = blockText(update.content as AcpContentBlock | undefined)
      return text ? [{ type: "text", text }] : []
    }
    case "agent_thought_chunk": {
      const text = blockText(update.content as AcpContentBlock | undefined)
      return text ? [{ type: "thinking", text }] : []
    }
    case "tool_call":
    case "tool_call_update":
      return [mapToolCall(update, tools)].filter(
        (event): event is AgentStreamEvent => event !== null
      )
    case "plan": {
      // `AgentStreamEvent` has no plan variant. Folding it into a single
      // upserting tool call is what lets the vendored components render it:
      // `todo-list` reads exactly these arguments, so the plan reaches both
      // the tool row and the panel above the composer with no new event type.
      const todos = planTodos(update.entries)
      return todos
        ? [
            {
              type: "tool",
              id: "acp-plan",
              name: "plan",
              status: "done",
              input: todos,
            },
          ]
        : []
    }
    // Echoes of our own prompt, token counters, and surfaces this app has no
    // home for yet (slash commands, modes, config changes).
    case "user_message_chunk":
    case "usage_update":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    default:
      return []
  }
}

function mapToolCall(
  update: AcpSessionUpdate,
  tools: Map<string, AcpToolCallSummary>
): AgentStreamEvent | null {
  const id = update.toolCallId
  if (!id) return null
  const known = tools.get(id)
  const summary: AcpToolCallSummary = {
    toolCallId: id,
    title: update.title ?? known?.title,
    kind: update.kind ?? known?.kind,
    rawInput: update.rawInput ?? known?.rawInput,
  }
  tools.set(id, summary)

  const status =
    update.status === "completed"
      ? "done"
      : update.status === "failed"
        ? "error"
        : "running"

  const raw =
    update.content === undefined
      ? undefined
      : flattenToolContent(update.content as AcpToolCallContent[])
  const read = raw ? unwrapReadEnvelope(raw) : null
  const output = read ? read.body : raw
  const input = toolInput(update.rawInput, summary.rawInput, read)
  const exitCode = exitCodeFrom(update.rawOutput)

  return {
    type: "tool",
    id,
    name: summary.title || "tool",
    status,
    ...(input ? { input } : null),
    ...(output ? { output } : null),
    ...(exitCode === undefined ? null : { exitCode }),
  }
}

/* -------------------------------------------------------------------------- */
/*                             read-tool envelopes                            */
/* -------------------------------------------------------------------------- */

type ReadEnvelope = { path?: string; body: string; startLine?: number }

/**
 * dsh reports a file read as its own envelope — `<path>…</path>`, `<type>`, then
 * a `<content>` whose every line is prefixed `N: ` — where pi and cursor hand
 * back the bare body. Left as-is the vendored read-file card draws its own
 * gutter next to dsh's prefixes (two columns of numbers) and shows the tags as
 * if they were the first lines of the file. Unwrapping the envelope here, in
 * app-local code, fixes the card without touching it and without any other
 * harness — whose output never matches this shape — seeing a change.
 */
const READ_ENVELOPE =
  /^\s*<path>([^<]*)<\/path>\s*(?:<type>([^<]*)<\/type>\s*)?<content>\r?\n?([\s\S]*?)(?:\r?\n?<\/content>)?\s*$/

function unwrapReadEnvelope(output: string): ReadEnvelope | null {
  const match = READ_ENVELOPE.exec(output)
  if (!match) return null
  const path = match[1].trim() || undefined
  const body = match[3]
  // A directory listing is not numbered; only a file body gets the strip.
  if ((match[2] ?? "file").trim() === "directory") return { path, body }
  const stripped = stripLineNumbers(body)
  return stripped ? { path, ...stripped } : { path, body }
}

/**
 * `N: text` on consecutive lines and nothing else — the numbering dsh adds, not
 * a numbered list that happens to live in the file. Any gap or unnumbered line
 * aborts the strip and the body is shown verbatim; the last line is exempt
 * because `truncate` can cut one in half.
 */
function stripLineNumbers(
  body: string
): { body: string; startLine: number } | null {
  const lines = body.split("\n")
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()
  if (lines.length === 0) return null

  const out: string[] = []
  let expected = 0
  for (const [index, line] of lines.entries()) {
    const match = /^ *(\d+): ?([\s\S]*)$/.exec(line)
    if (!match) {
      if (index === lines.length - 1 && index > 0) {
        out.push(line)
        break
      }
      return null
    }
    const number = Number(match[1])
    if (index === 0) expected = number
    else if (number !== expected + index) return null
    out.push(match[2])
  }
  return { body: out.join("\n"), startLine: expected }
}

/**
 * The args the card shows — and reads the file's path and window out of, for
 * its language and its gutter. dsh names neither in `rawInput`, so an unwrapped
 * envelope supplies them; whatever the agent did send always wins.
 */
function toolInput(
  updated: unknown,
  known: unknown,
  read: ReadEnvelope | null
): string | undefined {
  const derived: Record<string, unknown> = {}
  if (read?.path) derived.path = read.path
  if (read?.startLine && read.startLine > 1) derived.offset = read.startLine

  const base = updated ?? known
  if (Object.keys(derived).length === 0) {
    return updated === undefined ? undefined : stringify(updated)
  }
  if (base && typeof base === "object" && !Array.isArray(base)) {
    return stringify({ ...derived, ...(base as Record<string, unknown>) })
  }
  return base === undefined || base === null
    ? stringify(derived)
    : stringify(base)
}

/** Flattens the `content` / `diff` / `terminal` variants down to text. */
function flattenToolContent(content: AcpToolCallContent[] | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts = content
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      if (part.type === "diff") {
        const header = part.path ? `--- ${part.path}\n` : ""
        return `${header}${part.newText ?? ""}`
      }
      if (part.type === "terminal") {
        return part.terminalId ? `[terminal ${part.terminalId}]` : ""
      }
      return blockText(part.content) ?? ""
    })
    .filter(Boolean)
  return parts.length ? truncate(parts.join("\n")) : undefined
}

function blockText(block: AcpContentBlock | undefined): string | undefined {
  if (!block || typeof block !== "object") return undefined
  if (typeof block.text === "string" && block.text) return block.text
  if (typeof block.resource?.text === "string") return block.resource.text
  if (typeof block.uri === "string") return block.uri
  return undefined
}

/**
 * ACP plan entries as the argument payload a todo tool would have sent —
 * `{ todos: [{ content, status }] }`, which is what `parseTodoItems` in
 * `components/ui/todo-list` reads. ACP's own status words (`pending`,
 * `in_progress`, `completed`) are already the ones it normalizes to.
 */
function planTodos(entries: unknown): string | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined
  const todos = entries
    .map((entry) => {
      const item = (entry ?? {}) as { content?: string; status?: string }
      return { content: item.content ?? "", status: item.status ?? "pending" }
    })
    .filter((item) => item.content)
  return todos.length ? JSON.stringify({ todos }) : undefined
}

function stringify(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === "string") return truncate(value)
  try {
    return truncate(JSON.stringify(value, null, 2))
  } catch {
    return undefined
  }
}

function truncate(value: string) {
  return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…` : value
}

/* -------------------------------------------------------------------------- */
/*                                  the turn                                  */
/* -------------------------------------------------------------------------- */

export async function* runAcpAgent(
  options: AcpRunOptions
): AsyncGenerator<AgentStreamEvent> {
  const startedAt = Date.now()
  const conn = connectAcp(options.spawn)
  const queue = new EventQueue()
  const tools = new Map<string, AcpToolCallSummary>()
  /** `session/load` replays the whole transcript; we already have it stored. */
  const replay = { suppress: false }
  const cancelled = { value: false }

  const onAbort = () => {
    cancelled.value = true
    queue.finish()
  }
  options.signal?.addEventListener("abort", onAbort)

  conn.onNotification((method, params) => {
    if (method !== "session/update" || replay.suppress) return
    for (const event of mapAcpUpdate(params, tools)) queue.push(event)
  })

  conn.onRequest(async (method, params) => {
    if (method === "fs/read_text_file") {
      const p = (params ?? {}) as AcpReadTextFileParams
      if (!p.path) throw new AcpRpcError(ACP_ERROR.invalidParams, "path is required")
      return { content: await options.handlers.readTextFile({ path: p.path, line: p.line, limit: p.limit }) }
    }
    if (method === "fs/write_text_file") {
      // Undeclared capabilities are "not there" on the wire, so this is the
      // same answer the agent gets for any method we do not implement.
      if (!options.canWriteFiles) {
        throw new AcpRpcError(
          ACP_ERROR.methodNotFound,
          "fs/write_text_file is not available: this turn is read-only"
        )
      }
      const p = (params ?? {}) as AcpWriteTextFileParams
      if (!p.path) throw new AcpRpcError(ACP_ERROR.invalidParams, "path is required")
      await options.handlers.writeTextFile({ path: p.path, content: p.content ?? "" })
      return null
    }
    if (method === "session/request_permission") {
      const p = (params ?? {}) as AcpRequestPermissionParams
      const toolCallId = p.toolCall?.toolCallId ?? ""
      // The request carries only an id, so the label comes from the tool_call
      // update we already saw.
      const summary = tools.get(toolCallId) ?? { toolCallId }
      const choices = Array.isArray(p.options) ? p.options : []
      if (cancelled.value) return { outcome: { outcome: "cancelled" } }

      const { option, reason } = options.handlers.decidePermission({
        toolCall: summary,
        options: choices,
      })
      const chosen = option ?? pickRejection(choices)
      queue.push({
        type: "tool",
        id: `acp-permission-${toolCallId || choices.length}`,
        name: "permission",
        status: option ? "done" : "error",
        input: stringify({
          tool: summary.title ?? toolCallId,
          request: summary.rawInput,
        }),
        output: reason,
      })
      return chosen?.optionId
        ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
        : { outcome: { outcome: "cancelled" } }
    }
    throw new AcpRpcError(ACP_ERROR.methodNotFound, `Method not found: ${method}`)
  })

  try {
    const init = await conn.request<AcpInitializeResult>(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: options.canWriteFiles },
          terminal: false,
        },
        clientInfo: { name: "agent-ui", title: "Agent UI", version: "1" },
      },
      HANDSHAKE_MS
    )

    const version = init?.protocolVersion
    if (typeof version === "number" && version !== ACP_PROTOCOL_VERSION) {
      // Not fatal on its own — agents are allowed to answer with the newest
      // version they speak — but a mismatch means the wire shapes below may be
      // wrong, and a silent misparse is worse than saying so.
      yield {
        type: "error",
        message: `${options.label} speaks ACP v${version}; this app implements v${ACP_PROTOCOL_VERSION}.`,
      }
      return
    }

    const caps = init?.agentCapabilities ?? {}
    const cwd = options.spawn.cwd
    let sessionId = options.sessionId?.trim() || ""

    if (sessionId) {
      const resumed = await resumeSession(conn, caps, sessionId, cwd, replay)
      if (!resumed) sessionId = ""
    }
    if (!sessionId) {
      const created = await conn.request<AcpSessionNewResult>(
        "session/new",
        // `mcpServers` is mandatory even when empty.
        { cwd, mcpServers: [] },
        HANDSHAKE_MS
      )
      sessionId = created?.sessionId ?? ""
      if (!sessionId) {
        yield { type: "error", message: `${options.label} returned no session id` }
        return
      }
    }

    if (options.signal?.aborted) return
    yield { type: "session", sessionId }

    // Model and effort are `configOptions`, not prompt parameters. Failures are
    // non-fatal: an agent that does not expose the option still runs the turn
    // on whatever it is configured with.
    await setConfigOption(conn, sessionId, "model", options.model)
    await setConfigOption(conn, sessionId, "reasoning_effort", options.effort)

    const settled: { stopReason?: string; error?: unknown } = {}
    const turn = conn
      .request<AcpPromptResult>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: options.prompt }],
      })
      .then(
        (result) => {
          settled.stopReason = result?.stopReason
        },
        (err: unknown) => {
          settled.error = err
        }
      )
      .finally(() => queue.finish())

    const onCancel = () => conn.notify("session/cancel", { sessionId })
    options.signal?.addEventListener("abort", onCancel)

    try {
      for await (const event of queue.drain()) {
        if (cancelled.value) break
        yield event
      }
      // `turn` never rejects, so skipping it on abort leaks nothing — and
      // awaiting a prompt the user just stopped would stall the SSE close.
      if (!cancelled.value) await turn
    } finally {
      options.signal?.removeEventListener("abort", onCancel)
      if (caps.sessionCapabilities?.close !== undefined) {
        // Closing flushes the session log and hands the id back, so the next
        // turn's process can resume it instead of hitting "already active".
        const closing = conn
          .request("session/close", { sessionId }, HANDSHAKE_MS)
          .catch(() => undefined)
        if (!cancelled.value) await closing
      }
    }

    if (cancelled.value) return

    if (settled.error) {
      yield { type: "error", message: describeTurnFailure(settled.error, options.label) }
      return
    }
    if (settled.stopReason === "cancelled") return
    if (settled.stopReason === "refusal") {
      yield { type: "error", message: `${options.label} refused the request.` }
      return
    }
    yield { type: "done", sessionId, durationMs: Date.now() - startedAt }
  } catch (err) {
    if (!options.signal?.aborted) {
      yield { type: "error", message: describeTurnFailure(err, options.label) }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
    conn.dispose()
  }
}

/**
 * `session/resume` restores context without replaying history (this app already
 * stores the transcript); `session/load` is the older, replaying variant, whose
 * updates are dropped so a resumed thread does not duplicate itself. Either can
 * fail legitimately — a session the agent has forgotten, or one started in a
 * different workspace — in which case the caller starts a fresh one.
 */
async function resumeSession(
  conn: AcpConnection,
  caps: AcpInitializeResult["agentCapabilities"],
  sessionId: string,
  cwd: string,
  replay: { suppress: boolean }
): Promise<boolean> {
  const supportsResume = caps?.sessionCapabilities?.resume !== undefined
  const supportsLoad = caps?.loadSession === true
  if (!supportsResume && !supportsLoad) return false
  const method = supportsResume ? "session/resume" : "session/load"
  replay.suppress = method === "session/load"
  try {
    await conn.request(method, { sessionId, cwd, mcpServers: [] }, HANDSHAKE_MS)
    return true
  } catch (err) {
    if (err instanceof AcpRpcError) return false
    throw err
  } finally {
    replay.suppress = false
  }
}

/**
 * Config-option values are opaque to us, and the UI's effort ids
 * (low/medium/high/xhigh) are not the agent's vocabulary, so aliases are tried
 * in turn until one is accepted. Every failure is swallowed — this is a
 * refinement of the turn, never a reason to fail it.
 */
async function setConfigOption(
  conn: AcpConnection,
  sessionId: string,
  configId: string,
  value: string | undefined
) {
  const wanted = value?.trim()
  if (!wanted) return
  for (const candidate of configCandidates(configId, wanted)) {
    try {
      await conn.request("session/set_config_option", { sessionId, configId, value: candidate }, CONFIG_MS)
      return
    } catch {
      /* try the next alias */
    }
  }
}

/** UI effort id → the values agents actually publish. */
const EFFORT_ALIASES: Record<string, string[]> = {
  low: ["low", "minimal", "off"],
  medium: ["medium", "low", "high"],
  high: ["high", "medium"],
  xhigh: ["max", "xhigh", "high"],
}

function configCandidates(configId: string, value: string): string[] {
  if (configId !== "reasoning_effort") return [value]
  const aliases = EFFORT_ALIASES[value] ?? []
  return [...new Set([value, ...aliases])]
}

function pickRejection(options: AcpPermissionOption[]): AcpPermissionOption | null {
  return (
    options.find((option) => option.kind === "reject_once") ??
    options.find((option) => option.kind === "reject_always") ??
    null
  )
}

/**
 * Agent-side failures arrive as `-32603 Internal error: turn failed: <status>:
 * <raw upstream body>` — useful, but the body can be a wall of provider JSON.
 */
function describeTurnFailure(err: unknown, label: string): string {
  if (err instanceof AcpRpcError) return clip(`${label}: ${err.message}`)
  if (err instanceof Error) return clip(err.message)
  return `${label} failed`
}

/** Error text goes in a toast, so it stays readable. */
function clip(value: string, max = 600) {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/* -------------------------------------------------------------------------- */
/*                              model discovery                               */
/* -------------------------------------------------------------------------- */

/**
 * ACP has no model-listing RPC: an agent publishes its selectable settings as
 * `configOptions` on the `session/new` result. Discovering them therefore costs
 * a spawn and a throwaway session, so callers cache the result — same reasoning
 * as `lib/providers/cursor.ts`'s `modelCache` around `cursor-agent ls`.
 */
export async function probeAcpConfigOptions(
  spec: AcpSpawnSpec,
  label: string
): Promise<AcpConfigOption[]> {
  const conn = connectAcp(spec)
  conn.onRequest(async () => {
    throw new AcpRpcError(ACP_ERROR.methodNotFound, "Not available while probing")
  })
  try {
    const init = await conn.request<AcpInitializeResult>(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "agent-ui", title: "Agent UI", version: "1" },
      },
      HANDSHAKE_MS
    )
    const created = await conn.request<AcpSessionNewResult>(
      "session/new",
      { cwd: spec.cwd, mcpServers: [] },
      HANDSHAKE_MS
    )
    // Probing costs a real session; close it so it does not linger as active.
    if (created?.sessionId && init?.agentCapabilities?.sessionCapabilities?.close !== undefined) {
      await conn
        .request("session/close", { sessionId: created.sessionId }, HANDSHAKE_MS)
        .catch(() => undefined)
    }
    return created?.configOptions ?? []
  } catch (err) {
    throw new Error(describeTurnFailure(err, label))
  } finally {
    conn.dispose()
  }
}
