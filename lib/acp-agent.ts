import "server-only"

import { spawn } from "node:child_process"

import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import { resolveAcpCommand, type AcpCommand } from "@/lib/acp-runtime"
import {
  cancellationReply,
  mapAcpUpdate,
  sessionUpdateIsReplay,
  stringifyField,
  type AcpToolCallState,
  type AcpToolCallSummary,
} from "@/lib/acp-protocol"
import { sniffImageMimeType } from "@/lib/attachments"
import {
  detachedSpawnOptions,
  killProcessTree,
  trackChildProcess,
} from "@/lib/process-tree"
import { LineBuffer } from "@/lib/stream-framing"
import { UnfinishedTools } from "@/lib/unfinished-tools"
import {
  USER_REQUEST_WAITING,
  formatUserRequestInput,
  userRequestToolName,
  type AskUser,
  type UserRequest,
} from "@/lib/turn-requests"
import {
  ACP_ERROR,
  ACP_PROTOCOL_VERSION,
  AcpRpcError,
  type AcpAgentCapabilities,
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpPermissionOption,
  type AcpPromptResult,
  type AcpReadTextFileParams,
  type AcpRequestPermissionParams,
  type AcpSessionNewResult,
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

/** Re-exported so a consumer of the client needs only this module. */
export type { AcpToolCallState, AcpToolCallSummary }
export { mapAcpUpdate }

/** Which option to select, or null to fall back to a rejecting one, and why. */
export type AcpPermissionDecision = {
  option: AcpPermissionOption | null
  reason: string
  /**
   * Whether the tool call was allowed — the row's status. Defaults to "an
   * option was named", which is what a policy decision means; a user who
   * picks `reject_always` names an option and is still refusing.
   */
  approved?: boolean
}

export type AcpClientHandlers = {
  /** Absolute path in, file contents out. Throw `AcpRpcError` to refuse. */
  readTextFile(params: { path: string; line?: number; limit?: number }): Promise<string>
  writeTextFile(params: { path: string; content: string }): Promise<void>
  /**
   * Answers one `session/request_permission`. The agent's turn is stopped
   * until this resolves, which is exactly why it may take as long as it likes:
   * the policy paths answer synchronously, and the `ask` policy hands the
   * decision to the user through `ask` below.
   */
  decidePermission(request: {
    toolCall: AcpToolCallSummary
    options: AcpPermissionOption[]
    /**
     * Puts the decision to the user and waits. Present only when the run was
     * given an `askUser`; calling it is what publishes the waiting tool row,
     * so a policy that never asks never emits one.
     */
    ask?: AskUser
  }): AcpPermissionDecision | Promise<AcpPermissionDecision>
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
  /**
   * Base64 image payloads (no `data:` prefix) to send beside the prompt. Only
   * attached when the agent's `promptCapabilities.image` is true — an agent
   * that does not advertise images is sent none, whatever the chat carried.
   */
  images?: string[]
  /**
   * The channel a blocked turn answers through. Given one, the `ask` policy
   * puts every `session/request_permission` to the user instead of deciding
   * from settings.
   */
  askUser?: AskUser
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
  /**
   * Answers every inbound request still waiting on us, so an agent blocked on
   * a permission it can no longer be granted can settle its own turn instead
   * of hanging until the pipe closes under it.
   */
  cancelPendingRequests(): void
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
    // An ACP agent's shell tool runs commands as this process's
    // grandchildren; terminating the agent has to reach those too, and only a
    // process group can.
    ...detachedSpawnOptions,
  })
  trackChildProcess(child)

  // Decoding per chunk would tear a multi-byte character in half wherever the
  // pipe happened to break; the stream's own decoder holds the tail back until
  // the rest of the sequence arrives.
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")

  const pending = new Map<JsonRpcId, PendingCall>()
  /** Requests *from* the agent that we have not answered yet, by id. */
  const inbound = new Map<JsonRpcId, { method: string; answer: (payload: object) => void }>()
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
      // JSON-RPC allows exactly one response per id, and a sweep on stop races
      // the handler that is still running — so whichever answers first wins
      // and the other is dropped.
      const reply = (payload: object) => {
        if (!inbound.delete(id)) return
        write({ jsonrpc: "2.0", id, ...payload })
      }
      inbound.set(id, { method, answer: reply })
      const handler = onRequest
      const answer = handler
        ? handler(method, message.params)
        : Promise.reject(
            new AcpRpcError(ACP_ERROR.methodNotFound, `Method not found: ${method}`)
          )
      void answer.then(
        (result) => reply({ result: result ?? null }),
        (err: unknown) => {
          const rpc =
            err instanceof AcpRpcError
              ? { code: rpcCode(err), message: err.message, data: err.data }
              : {
                  code: ACP_ERROR.internalError,
                  message: err instanceof Error ? err.message : String(err),
                }
          reply({ error: rpc })
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
    cancelPendingRequests() {
      for (const { method, answer } of [...inbound.values()]) {
        answer(cancellationReply(method))
      }
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
        // The whole group, not the agent alone: whatever its shell tool
        // started is still running in there.
        killProcessTree(child)
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
/*                                  the turn                                  */
/* -------------------------------------------------------------------------- */

export async function* runAcpAgent(
  options: AcpRunOptions
): AsyncGenerator<AgentStreamEvent> {
  const startedAt = Date.now()
  const conn = connectAcp(options.spawn)
  const queue = new EventQueue()
  const tools = new Map<string, AcpToolCallState>()
  /** `session/load` replays the whole transcript; we already have it stored. */
  const replay = { suppress: false }
  const cancelled = { value: false }
  /** Rows the agent started and never closed, for the abnormal ends below. */
  const openTools = new UnfinishedTools()

  const onAbort = () => {
    cancelled.value = true
    // The agent is blocked on whatever it last asked us. Answering "cancelled"
    // lets it settle its own turn instead of waiting for the pipe to close.
    conn.cancelPendingRequests()
    queue.finish()
  }
  options.signal?.addEventListener("abort", onAbort)

  conn.onNotification((method, params) => {
    if (method !== "session/update") return
    // Two ways an agent says "this is history, not news": the `session/load`
    // call we made (latched around the request) and a per-notification marker
    // some agents send instead. Either way we already have the transcript.
    if (replay.suppress || sessionUpdateIsReplay(params)) return
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
      // A request that arrives after the stop is answered here; one that was
      // already in flight is answered by the sweep in `onAbort`. Today's
      // policy decides synchronously, so that window is an instant — but it is
      // the window that would open the moment a policy ever has to await, and
      // an unanswered permission is a turn the agent can never settle.
      if (cancelled.value) return { outcome: { outcome: "cancelled" } }

      const rowId = `acp-permission-${toolCallId || choices.length}`
      /**
       * Asking publishes the row *before* awaiting, never after: `queue.push`
       * only wakes the drain loop, and the generator can only reach the
       * consumer while this handler is parked on the promise below. Push after
       * the await and the user is looking at a turn that has gone silent with
       * no sign of what it is waiting for.
       */
      let asked = false
      const ask: AskUser | undefined = options.askUser
        ? async (request: UserRequest) => {
            asked = true
            queue.push({
              type: "tool",
              id: rowId,
              name: userRequestToolName(request.kind),
              status: "running",
              input: formatUserRequestInput(request),
              output: USER_REQUEST_WAITING,
            })
            return options.askUser!(request)
          }
        : undefined

      const decision = await options.handlers.decidePermission({
        toolCall: summary,
        options: choices,
        ask,
      })
      // Stopping the turn while the form was open is not a decision: the row
      // says so and the agent is told its prompt was cancelled.
      if (cancelled.value) {
        if (asked) {
          queue.push({
            type: "tool",
            id: rowId,
            name: "permission",
            status: "error",
            output: "Stopped before you answered.",
          })
        }
        return { outcome: { outcome: "cancelled" } }
      }
      const { option, reason } = decision
      const approved = decision.approved ?? option !== null
      const chosen = option ?? pickRejection(choices)
      queue.push({
        type: "tool",
        id: rowId,
        name: "permission",
        status: approved ? "done" : "error",
        // An asked row already carries the request as its input;
        // `upsertToolPart` keeps it when the settling event brings none.
        ...(asked
          ? null
          : {
              input: stringifyField({
                tool: summary.title ?? toolCallId,
                request: summary.rawInput,
              }),
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
        prompt: promptBlocks(
          options.prompt,
          caps.promptCapabilities?.image === true ? options.images : undefined
        ),
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
        openTools.track(event)
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

    // Whatever ended the turn — a stop, an agent-side failure, a stream that
    // stopped before the tool call came back — a row left `running` would spin
    // for the rest of the transcript's life.
    yield* openTools.finish()

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
    yield* openTools.finish()
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

/**
 * The `session/prompt` content blocks for one turn. Images are only ever
 * appended by a caller that checked `promptCapabilities.image` — an agent that
 * does not advertise them is sent text alone rather than a block it will
 * reject, and the route's base64 carries no mime type, so it is sniffed from
 * the payload's own magic bytes (`lib/attachments`).
 */
function promptBlocks(
  prompt: string,
  images: string[] | undefined
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [{ type: "text", text: prompt }]
  for (const data of images ?? []) {
    if (!data) continue
    blocks.push({ type: "image", data, mimeType: sniffImageMimeType(data) })
  }
  return blocks
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
export type AcpProbeResult = {
  options: AcpConfigOption[]
  /**
   * What the agent said it accepts beside text on `initialize`. It is the only
   * honest source for `capabilities.vision`: a model appearing in a catalog
   * says nothing about the transport, so an agent that publishes nothing here
   * stays vision-less.
   */
  promptCapabilities?: AcpAgentCapabilities["promptCapabilities"]
}

export async function probeAcpConfigOptions(
  spec: AcpSpawnSpec,
  label: string
): Promise<AcpProbeResult> {
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
    return {
      options: created?.configOptions ?? [],
      ...(init?.agentCapabilities?.promptCapabilities
        ? { promptCapabilities: init.agentCapabilities.promptCapabilities }
        : null),
    }
  } catch (err) {
    throw new Error(describeTurnFailure(err, label))
  } finally {
    conn.dispose()
  }
}

/**
 * One ACP method call over a throwaway process: spawn, `initialize`, ask, kill.
 *
 * It exists for the *extension* methods an agent publishes outside the base
 * protocol — Cursor's `cursor/list_available_models` is the one this app uses
 * — which answer straight after the handshake and need no session at all. No
 * inbound request is served while it runs: there is no turn behind it that
 * could honour one.
 */
export async function acpExtensionRequest<T>(
  spec: AcpSpawnSpec,
  method: string,
  params: unknown = {},
  timeoutMs = HANDSHAKE_MS
): Promise<T> {
  const conn = connectAcp(spec)
  conn.onRequest(async () => {
    throw new AcpRpcError(ACP_ERROR.methodNotFound, "Not available while probing")
  })
  try {
    await conn.request<AcpInitializeResult>(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "agent-ui", title: "Agent UI", version: "1" },
      },
      timeoutMs
    )
    return await conn.request<T>(method, params, timeoutMs)
  } finally {
    conn.dispose()
  }
}
