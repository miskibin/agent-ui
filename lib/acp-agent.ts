import "server-only"

import { spawn } from "node:child_process"

import type { AgentStreamEvent, AgentTokenUsage } from "@/lib/cursor-agent-types"
import { resolveAcpCommand, type AcpCommand } from "@/lib/acp-runtime"
import {
  cancellationReply,
  commandsFromUpdate,
  mapAcpUpdate,
  matchSessionMode,
  sessionUpdateIsReplay,
  stringifyField,
  usageFromUpdate,
  withConversationReplay,
  type AcpCommand as AcpSlashCommand,
  type AcpContextUsage,
  type AcpReplayTurn,
  type AcpToolCallState,
  type AcpToolCallSummary,
} from "@/lib/acp-protocol"
import { AcpTerminals } from "@/lib/acp-terminals"
import { wslCommandMissing } from "@/lib/acp-wsl"
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
  type AcpCreateTerminalParams,
  type AcpPromptResult,
  type AcpReadTextFileParams,
  type AcpRequestPermissionParams,
  type AcpSessionModeState,
  type AcpSessionNewResult,
  type AcpSessionResumeResult,
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
 * Lifecycle: an ACP agent is a *server* that holds its sessions in memory,
 * so the process is kept between turns (`keepAlive`) the way an editor keeps
 * it — one live process per agent configuration, reused by every chat that
 * runs on it, each chat its own ACP session inside it. That is what makes an
 * agent with no `session/load` (tinyagent, and anything else that keeps its
 * conversation in memory) remember the previous message at all. A process
 * idle for `IDLE_MS` is closed; when a chat's session is no longer live,
 * `session/resume` or `session/load` restores it where the agent supports
 * either, and otherwise a fresh session is briefed with the transcript.
 */

/** The handshake is bounded; the turn itself is bounded by the route's abort. */
const HANDSHAKE_MS = 45_000
/** Config options are a refinement of the turn, so they wait much less. */
const CONFIG_MS = 10_000
/** How long a closing agent gets to drain before SIGTERM. */
const SHUTDOWN_MS = 750
/** How long an unused agent process is kept for the next turn. */
const IDLE_MS = 15 * 60 * 1000
/** Idle agent processes kept at once; the least recently used goes first. */
const MAX_IDLE_HOSTS = 6
/** How long a cancelled turn gets to settle before its process is killed. */
const CANCEL_GRACE_MS = 5_000

export { AcpRpcError }

export type AcpSpawnSpec = {
  command: string
  args: string[]
  /** Where the process is started, on this machine. */
  cwd: string
  env: Record<string, string>
  /**
   * The same folder as the *agent* spells it, for `session/new` — different
   * from `cwd` only for an agent under WSL (`/mnt/c/…` for `C:\…`).
   */
  agentCwd?: string
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
  /**
   * Keep the agent process for the next turn instead of killing it. On for
   * every real run; the tests that script a one-shot agent leave it off.
   */
  keepAlive?: boolean
  /**
   * The chat's earlier turns, for briefing a *fresh* session in a chat that
   * already had one (see `withConversationReplay`). Ignored whenever the
   * agent's own session survived.
   */
  history?: AcpReplayTurn[]
  /**
   * The app's permission mode for the turn, matched against the agent's own
   * session modes (`session/set_mode`) where it publishes any.
   */
  sessionMode?: string
  /** Translates a path the agent reported into one this machine can open. */
  toAppPath?: (path: string) => string
  /** Offer `terminal/*`: the agent runs commands through us, inside `terminalRoot`. */
  terminalRoot?: string
  /** The agent published (or changed) its own `/` commands. */
  onCommands?: (commands: AcpSlashCommand[]) => void
  /** The agent published its session modes — learned for the permission picker. */
  onModes?: (modes: AcpSessionModeState) => void
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
  cancelPendingRequests(sessionId?: string): void
  /** Whether the process is gone (exited, failed to spawn, or disposed). */
  isClosed(): boolean
  onClose(handler: () => void): void
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
  const inbound = new Map<
    JsonRpcId,
    { method: string; sessionId?: string; answer: (payload: object) => void }
  >()
  const closeHandlers: Array<() => void> = []
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
    for (const handler of closeHandlers.splice(0)) handler()
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
      const sessionId = (message.params as { sessionId?: unknown } | undefined)?.sessionId
      inbound.set(id, {
        method,
        ...(typeof sessionId === "string" ? { sessionId } : null),
        answer: reply,
      })
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
    cancelPendingRequests(sessionId) {
      for (const entry of [...inbound.values()]) {
        if (sessionId && entry.sessionId && entry.sessionId !== sessionId) continue
        entry.answer(cancellationReply(entry.method))
      }
    },
    isClosed: () => closed,
    onClose(handler) {
      if (closed) handler()
      else closeHandlers.push(handler)
    },
    spawnFailure: () => failure.error,
    stderr: () => stderrChunks.join("").trim(),
    dispose() {
      fail(new Error(`${command.cmd} was closed`))
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

/**
 * Where one session's traffic goes. An agent process can hold several
 * sessions — one per chat that runs on it — and both its notifications and
 * its requests name the session they are about.
 */
type SessionRoute = {
  notify(method: string, params: unknown): void
  request: InboundHandler
}

/**
 * One agent process and the sessions alive in it.
 *
 * `live` is what lets the next turn skip `session/load` entirely: a session
 * in it is still in the agent's memory, exactly as an editor would find it.
 */
type AcpHost = {
  key: string
  conn: AcpConnection
  init: AcpInitializeResult
  pooled: boolean
  live: Set<string>
  modes: Map<string, AcpSessionModeState>
  routes: Map<string, SessionRoute>
  /** The turn still establishing its session, for traffic that names none yet. */
  establishing: SessionRoute[]
  terminals: AcpTerminals
  busy: number
  lastUsed: number
  idleTimer?: NodeJS.Timeout
}

type HostPool = Map<string, Promise<AcpHost>>

/**
 * Module state outlives a request but not a dev-server reload, which would
 * otherwise leave a second pool beside the first with its processes orphaned
 * — so the pool hangs off `globalThis`, like every other process registry a
 * hot-reloaded server keeps.
 */
const POOL_KEY = Symbol.for("agent-ui.acp-hosts")
function hostPool(): HostPool {
  const holder = globalThis as unknown as Record<symbol, HostPool | undefined>
  holder[POOL_KEY] ??= new Map()
  return holder[POOL_KEY]
}

/** Everything that makes two processes different — and nothing else. */
function hostKey(spec: AcpSpawnSpec, canWriteFiles: boolean, terminal: boolean) {
  const env = Object.keys(spec.env)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => [name, spec.env[name]])
  return JSON.stringify([
    spec.command,
    spec.args,
    spec.cwd,
    spec.agentCwd ?? "",
    env,
    canWriteFiles,
    terminal,
  ])
}

function initializeParams(canWriteFiles: boolean, terminal: boolean) {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: canWriteFiles },
      terminal,
    },
    clientInfo: { name: "agent-ui", title: "Agent UI", version: "1" },
  }
}

async function startHost(
  key: string,
  spec: AcpSpawnSpec,
  canWriteFiles: boolean,
  terminal: boolean,
  pooled: boolean
): Promise<AcpHost> {
  const conn = connectAcp(spec)
  const host: AcpHost = {
    key,
    conn,
    init: {},
    pooled,
    live: new Set(),
    modes: new Map(),
    routes: new Map(),
    establishing: [],
    terminals: new AcpTerminals(),
    busy: 0,
    lastUsed: Date.now(),
  }
  const routeFor = (params: unknown): SessionRoute | undefined => {
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId
    if (typeof sessionId === "string") {
      const route = host.routes.get(sessionId)
      if (route) return route
    }
    return host.establishing.at(-1) ?? (host.routes.size === 1 ? [...host.routes.values()][0] : undefined)
  }
  conn.onNotification((method, params) => routeFor(params)?.notify(method, params))
  conn.onRequest(async (method, params) => {
    const route = routeFor(params)
    if (!route) {
      throw new AcpRpcError(ACP_ERROR.invalidParams, `No turn is running for ${method}`)
    }
    return route.request(method, params)
  })
  conn.onClose(() => {
    host.terminals.disposeAll()
    if (pooled) forget(host)
  })
  try {
    host.init =
      (await conn.request<AcpInitializeResult>(
        "initialize",
        initializeParams(canWriteFiles, terminal),
        HANDSHAKE_MS
      )) ?? {}
  } catch (err) {
    conn.dispose()
    throw err
  }
  return host
}

async function acquireHost(
  spec: AcpSpawnSpec,
  canWriteFiles: boolean,
  terminal: boolean,
  keepAlive: boolean
): Promise<AcpHost> {
  const key = hostKey(spec, canWriteFiles, terminal)
  if (!keepAlive) {
    const host = await startHost(key, spec, canWriteFiles, terminal, false)
    host.busy++
    return host
  }
  const pool = hostPool()
  const existing = pool.get(key)
  if (existing) {
    const host = await existing.catch(() => null)
    if (host && !host.conn.isClosed()) {
      if (host.idleTimer) clearTimeout(host.idleTimer)
      host.idleTimer = undefined
      host.busy++
      return host
    }
    if (pool.get(key) === existing) pool.delete(key)
  }
  const starting = startHost(key, spec, canWriteFiles, terminal, true)
  pool.set(key, starting)
  starting.catch(() => {
    if (pool.get(key) === starting) pool.delete(key)
  })
  const host = await starting
  host.busy++
  return host
}

/** A turn is done with its host: keep it for the next one, or close it. */
function releaseHost(host: AcpHost, healthy: boolean) {
  host.busy = Math.max(0, host.busy - 1)
  host.lastUsed = Date.now()
  if (!host.pooled || !healthy || host.conn.isClosed()) {
    closeHost(host)
    return
  }
  if (host.busy > 0) return
  host.idleTimer = setTimeout(() => closeHost(host), IDLE_MS)
  host.idleTimer.unref?.()
  trimIdleHosts()
}

function trimIdleHosts() {
  const idle: AcpHost[] = []
  // Only hosts that finished starting can be inspected synchronously; one
  // still starting is about to be used by definition.
  for (const host of settledHosts) {
    if (host.busy === 0 && !host.conn.isClosed()) idle.push(host)
  }
  idle.sort((a, b) => a.lastUsed - b.lastUsed)
  while (idle.length > MAX_IDLE_HOSTS) closeHost(idle.shift()!)
}

/** Hosts whose start has finished, for the synchronous idle sweep. */
const settledHosts = new Set<AcpHost>()

function forget(host: AcpHost) {
  settledHosts.delete(host)
  const pool = hostPool()
  const entry = pool.get(host.key)
  if (!entry) return
  void entry.then((current) => {
    if (current === host && pool.get(host.key) === entry) pool.delete(host.key)
  }, () => undefined)
}

/**
 * Closing is polite first: an agent that can close a session gets to flush
 * it (dsh writes its session log there, which is what a later
 * `session/resume` reads), then the process and every terminal it started
 * go.
 */
function closeHost(host: AcpHost) {
  if (host.idleTimer) clearTimeout(host.idleTimer)
  host.idleTimer = undefined
  forget(host)
  const conn = host.conn
  if (conn.isClosed()) {
    host.terminals.disposeAll()
    return
  }
  const sessions = [...host.live]
  host.live.clear()
  const canClose = host.init.agentCapabilities?.sessionCapabilities?.close !== undefined
  const closing = canClose
    ? Promise.all(
        sessions.map((sessionId) =>
          conn.request("session/close", { sessionId }, 2_000).catch(() => undefined)
        )
      )
    : Promise.resolve()
  void closing.finally(() => {
    host.terminals.disposeAll()
    conn.dispose()
  })
}

/** Ends every pooled agent process — for tests, and for a settings change. */
export async function closeAcpHosts(): Promise<void> {
  const pool = hostPool()
  const hosts = await Promise.all(
    [...pool.values()].map((pending) => pending.catch(() => null))
  )
  pool.clear()
  for (const host of hosts) if (host) closeHost(host)
}

export async function* runAcpAgent(
  options: AcpRunOptions
): AsyncGenerator<AgentStreamEvent> {
  const startedAt = Date.now()
  const queue = new EventQueue()
  const tools = new Map<string, AcpToolCallState>()
  /** `session/load` replays the whole transcript; we already have it stored. */
  const replay = { suppress: false }
  const cancelled = { value: false }
  /** Rows the agent started and never closed, for the abnormal ends below. */
  const openTools = new UnfinishedTools()
  let contextUsage: AcpContextUsage | null = null
  let sessionId = ""

  // Under WSL the agent's commands would run on the wrong side of the
  // boundary, so a terminal is offered only to an agent that shares our
  // filesystem — which is exactly when the caller names a root for it.
  const terminal = !!options.terminalRoot && options.canWriteFiles

  let host: AcpHost
  try {
    host = await acquireHost(options.spawn, options.canWriteFiles, terminal, !!options.keepAlive)
  } catch (err) {
    if (!options.signal?.aborted) {
      yield { type: "error", message: describeTurnFailure(err, options.label) }
    }
    return
  }
  settledHosts.add(host)
  const conn = host.conn

  const route: SessionRoute = {
    notify(method, params) {
      if (method !== "session/update") return
      // Two ways an agent says "this is history, not news": the `session/load`
      // call we made (latched around the request) and a per-notification marker
      // some agents send instead. Either way we already have the transcript.
      if (replay.suppress || sessionUpdateIsReplay(params)) return
      const usage = usageFromUpdate(params)
      if (usage) {
        contextUsage = usage
        return
      }
      const commands = commandsFromUpdate(params)
      if (commands) {
        options.onCommands?.(commands)
        return
      }
      const update = (params as { update?: { sessionUpdate?: string; currentModeId?: string } })?.update
      if (update?.sessionUpdate === "current_mode_update" && sessionId) {
        const state = host.modes.get(sessionId)
        if (state && update.currentModeId) {
          host.modes.set(sessionId, { ...state, currentModeId: update.currentModeId })
        }
        return
      }
      for (const event of mapAcpUpdate(params, tools, {
        toAppPath: options.toAppPath,
        terminalOutput: (id) => host.terminals.peek(id),
      })) {
        queue.push(event)
      }
    },
    request: (method, params) => handleRequest(method, params),
  }

  const onAbort = () => {
    cancelled.value = true
    // The agent is blocked on whatever it last asked us. Answering "cancelled"
    // lets it settle its own turn instead of waiting for the pipe to close.
    conn.cancelPendingRequests(sessionId || undefined)
    if (sessionId) conn.notify("session/cancel", { sessionId })
    queue.finish()
  }
  options.signal?.addEventListener("abort", onAbort)

  async function handleRequest(method: string, params: unknown): Promise<unknown> {
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
    if (method.startsWith("terminal/")) {
      if (!terminal || !options.terminalRoot) {
        throw new AcpRpcError(ACP_ERROR.methodNotFound, `${method} is not available this turn`)
      }
      if (cancelled.value && method === "terminal/create") {
        throw new AcpRpcError(ACP_ERROR.internalError, "The turn was cancelled")
      }
      const p = (params ?? {}) as AcpCreateTerminalParams & { terminalId?: string }
      switch (method) {
        case "terminal/create":
          return host.terminals.create(p, options.terminalRoot)
        case "terminal/output":
          return host.terminals.output(p.terminalId)
        case "terminal/wait_for_exit":
          return host.terminals.waitForExit(p.terminalId)
        case "terminal/kill":
          return host.terminals.kill(p.terminalId)
        case "terminal/release":
          return host.terminals.release(p.terminalId)
      }
    }
    if (method === "session/request_permission") {
      const p = (params ?? {}) as AcpRequestPermissionParams
      const toolCallId = p.toolCall?.toolCallId ?? ""
      // The request carries only an id, so the label comes from the tool_call
      // update we already saw.
      const summary = tools.get(toolCallId) ?? { toolCallId }
      const choices = Array.isArray(p.options) ? p.options : []
      // A request that arrives after the stop is answered here; one that was
      // already in flight is answered by the sweep in `onAbort`.
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
  }

  /** Whether the process can serve the next turn once this one is over. */
  let healthy = true
  /** The prompt request, while it is outstanding. */
  let turn: Promise<void> | null = null
  let settled = false

  host.establishing.push(route)
  try {
    const init = host.init

    const version = init?.protocolVersion
    if (typeof version === "number" && version !== ACP_PROTOCOL_VERSION) {
      // Not fatal on its own — agents are allowed to answer with the newest
      // version they speak — but a mismatch means the wire shapes below may be
      // wrong, and a silent misparse is worse than saying so.
      healthy = false
      yield {
        type: "error",
        message: `${options.label} speaks ACP v${version}; this app implements v${ACP_PROTOCOL_VERSION}.`,
      }
      return
    }

    const caps = init?.agentCapabilities ?? {}
    const cwd = options.spawn.agentCwd || options.spawn.cwd
    const requested = options.sessionId?.trim() || ""
    let fresh = false

    if (requested && host.live.has(requested) && !host.routes.has(requested)) {
      // Still in the agent's memory: nothing to restore.
      sessionId = requested
    } else if (requested && !host.routes.has(requested)) {
      host.routes.set(requested, route)
      const resumed = await resumeSession(conn, caps, requested, cwd, replay)
      if (resumed) {
        sessionId = requested
        host.live.add(sessionId)
        if (resumed.modes) host.modes.set(sessionId, resumed.modes)
      } else {
        host.routes.delete(requested)
      }
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
      fresh = true
      host.live.add(sessionId)
      if (created?.modes) host.modes.set(sessionId, created.modes)
    }
    host.routes.set(sessionId, route)
    host.establishing.splice(host.establishing.indexOf(route), 1)

    if (options.signal?.aborted) return
    yield { type: "session", sessionId }

    const modes = host.modes.get(sessionId)
    if (modes) options.onModes?.(modes)
    const wantedMode = matchSessionMode(options.sessionMode, modes?.availableModes)
    if (wantedMode && wantedMode !== modes?.currentModeId) {
      try {
        await conn.request("session/set_mode", { sessionId, modeId: wantedMode }, CONFIG_MS)
        host.modes.set(sessionId, { ...modes, currentModeId: wantedMode })
      } catch {
        /* a refinement of the turn, never a reason to fail it */
      }
    }

    // Model and effort are `configOptions`, not prompt parameters. Failures are
    // non-fatal: an agent that does not expose the option still runs the turn
    // on whatever it is configured with.
    await setConfigOption(conn, sessionId, "model", options.model)
    await setConfigOption(conn, sessionId, "reasoning_effort", options.effort)

    // A chat that had a session, now talking to a fresh one: the agent has to
    // be told what was already said, or it answers as if this were message one.
    const prompt = fresh ? withConversationReplay(options.prompt, options.history) : options.prompt

    const result: { stopReason?: string; usage?: AcpPromptResult["usage"]; error?: unknown } = {}
    turn = conn
      .request<AcpPromptResult>("session/prompt", {
        sessionId,
        prompt: promptBlocks(
          prompt,
          caps.promptCapabilities?.image === true ? options.images : undefined
        ),
      })
      .then(
        (value) => {
          result.stopReason = value?.stopReason
          result.usage = value?.usage
        },
        (err: unknown) => {
          result.error = err
        }
      )
      .finally(() => {
        settled = true
        queue.finish()
      })

    for await (const event of queue.drain()) {
      if (cancelled.value) break
      openTools.track(event)
      yield event
    }
    // `turn` never rejects, so skipping it on abort leaks nothing — and
    // awaiting a prompt the user just stopped would stall the SSE close.
    if (!cancelled.value) await turn

    if (!options.keepAlive && caps.sessionCapabilities?.close !== undefined) {
      // A process that dies with the turn closes its session first: that
      // flushes the session log, so the next turn's process can resume it
      // instead of hitting "already active".
      host.live.delete(sessionId)
      const closing = conn
        .request("session/close", { sessionId }, HANDSHAKE_MS)
        .catch(() => undefined)
      if (!cancelled.value) await closing
    }

    // Whatever ended the turn — a stop, an agent-side failure, a stream that
    // stopped before the tool call came back — a row left `running` would spin
    // for the rest of the transcript's life.
    yield* openTools.finish()

    if (cancelled.value) return

    if (result.error) {
      // An RPC error is the agent refusing this prompt; anything else is the
      // pipe itself, and a process that lost its pipe serves nobody.
      if (!(result.error instanceof AcpRpcError)) healthy = false
      yield { type: "error", message: describeTurnFailure(result.error, options.label, options.spawn) }
      return
    }
    if (result.stopReason === "cancelled") return
    if (result.stopReason === "refusal") {
      yield { type: "error", message: `${options.label} refused the request.` }
      return
    }
    const usage = turnUsage(result.usage, contextUsage)
    yield {
      type: "done",
      sessionId,
      durationMs: Date.now() - startedAt,
      ...(usage ? { usage } : null),
    }
  } catch (err) {
    healthy = false
    yield* openTools.finish()
    if (!options.signal?.aborted) {
      yield { type: "error", message: describeTurnFailure(err, options.label, options.spawn) }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
    const index = host.establishing.indexOf(route)
    if (index >= 0) host.establishing.splice(index, 1)
    if (host.routes.get(sessionId) === route) host.routes.delete(sessionId)
    if (turn && !settled) {
      // Stopped mid-prompt. The agent was told to cancel; it gets a moment to
      // settle, and a process that will not is killed rather than handed to
      // the next turn with a prompt still running in it.
      const pending = turn
      const grace = setTimeout(() => releaseHost(host, false), CANCEL_GRACE_MS)
      grace.unref?.()
      void pending.then(() => {
        clearTimeout(grace)
        releaseHost(host, healthy)
      })
    } else {
      releaseHost(host, healthy)
    }
  }
}

/**
 * What the turn cost, from whichever of ACP's two reports arrived.
 *
 * The prompt result's `usage` (where an agent attaches one) is the turn's own
 * spend. A `usage_update` is the context window's fill — the number the
 * composer's meter wants, and the only count an agent like tinyagent sends —
 * so it stands in for the input side when there is nothing better.
 */
function turnUsage(
  prompt: AcpPromptResult["usage"],
  context: AcpContextUsage | null
): AgentTokenUsage | undefined {
  const usage: AgentTokenUsage = {}
  if (prompt) {
    if (typeof prompt.inputTokens === "number") usage.input = prompt.inputTokens
    if (typeof prompt.outputTokens === "number") usage.output = prompt.outputTokens
    if (typeof prompt.cachedReadTokens === "number") usage.cachedInputTokens = prompt.cachedReadTokens
    if (typeof prompt.cachedWriteTokens === "number") usage.cacheCreationTokens = prompt.cachedWriteTokens
    if (typeof prompt.thoughtTokens === "number") usage.reasoningTokens = prompt.thoughtTokens
  }
  if (context) {
    if (usage.input === undefined && usage.output === undefined) usage.input = context.used
    if (context.size) usage.contextWindow = context.size
  }
  return Object.keys(usage).length > 0 ? usage : undefined
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
): Promise<AcpSessionResumeResult | null> {
  const supportsResume = caps?.sessionCapabilities?.resume !== undefined
  const supportsLoad = caps?.loadSession === true
  if (!supportsResume && !supportsLoad) return null
  const method = supportsResume ? "session/resume" : "session/load"
  replay.suppress = method === "session/load"
  try {
    const result = await conn.request<AcpSessionResumeResult | null>(
      method,
      { sessionId, cwd, mcpServers: [] },
      HANDSHAKE_MS
    )
    return result ?? {}
  } catch (err) {
    if (err instanceof AcpRpcError) return null
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
function describeTurnFailure(err: unknown, label: string, spawn?: AcpSpawnSpec): string {
  if (err instanceof AcpRpcError) return clip(`${label}: ${err.message}`)
  if (err instanceof Error) {
    const wslCommand = spawn ? wslAgentCommand(spawn) : null
    if (wslCommand && wslCommandMissing(err.message, wslCommand)) {
      return clip(
        `\`${wslCommand}\` was not found inside WSL. Install it there, or set the agent's command to its full Linux path (for example ~/.local/bin/${wslCommand.split("/").pop()}). WSL said: ${err.message}`
      )
    }
    return clip(err.message)
  }
  return `${label} failed`
}

/** The Linux command a `wslSpawn` spec runs, or null for a native spawn. */
function wslAgentCommand(spawn: AcpSpawnSpec): string | null {
  if (!/(^|[\\/])wsl(\.exe)?$/i.test(spawn.command)) return null
  const marker = spawn.args.indexOf('exec "$0" "$@"')
  return marker >= 0 ? (spawn.args[marker + 1] ?? null) : null
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
  /** The agent's own session modes, when it publishes any. */
  modes?: AcpSessionModeState
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
      ...(created?.modes ? { modes: created.modes } : null),
      ...(init?.agentCapabilities?.promptCapabilities
        ? { promptCapabilities: init.agentCapabilities.promptCapabilities }
        : null),
    }
  } catch (err) {
    throw new Error(describeTurnFailure(err, label, spec))
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
