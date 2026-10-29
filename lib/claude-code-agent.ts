import "server-only"

import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  buildArgs,
  ClaudeCodeTranslator,
  mcpConfigJson,
  parseCliLine,
} from "@/lib/claude-code-protocol"
import { rememberContextWindow } from "@/lib/claude-code-context"
import {
  resolveClaudeCodeCommand,
  type ClaudeCodeCommand,
} from "@/lib/claude-code-runtime"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import {
  detachedSpawnOptions,
  killProcessTree,
  trackChildProcess,
} from "@/lib/process-tree"
import type {
  McpServerConfig,
  PermissionMode,
  TurnProcessScope,
} from "@/lib/providers/types"
import { dataDir } from "@/lib/settings/server"
import { LineBuffer } from "@/lib/stream-framing"
import { AsyncEventQueue } from "@/lib/async-event-queue"
import { ClaudeCodeControl, claudeUserMessage, interactiveClaudeEvent } from "@/lib/claude-code-control"
import type { AskUser } from "@/lib/turn-requests"
import { UnfinishedTools } from "@/lib/unfinished-tools"

/**
 * Spawns the Claude Code CLI in `-p --output-format stream-json` and streams
 * the shared `AgentStreamEvent` protocol out of it.
 *
 * The whole agent loop runs inside the subprocess, so one call here is one
 * full agentic turn: the events interleave assistant text with the tool calls
 * Claude made along the way. `lib/claude-code-protocol` owns what those events
 * mean and what argv asks for them; this file owns the process — stdin, the
 * NDJSON framing, aborts, and a binary that dies without ever saying why.
 */

export type ClaudeCodeRunOptions = {
  prompt: string
  model: string
  /** Claude Code session id to `--resume`; absent starts a new one. */
  sessionId?: string
  /** `--effort`: low | medium | high | xhigh | max. */
  effort?: string
  images?: string[]
  askUser?: AskUser
  permissionMode: PermissionMode
  workspace: string
  binPath?: string
  /** MCP servers to attach for this turn (the app's subagent bridge). */
  mcpServers?: McpServerConfig[]
  /** Keeps what the agent left running at a normal end; see `AgentRunOptions`. */
  processes?: TurnProcessScope
  signal?: AbortSignal
}

const MAX_FIELD = 50_000

export async function* runClaudeCodeAgent(
  options: ClaudeCodeRunOptions
): AsyncGenerator<AgentStreamEvent> {
  if (options.signal?.aborted) return
  const startedAt = Date.now()
  const command = resolveClaudeCodeCommand(options.binPath)
  const { cmd, args: prefix } = command
  const mcpServers = options.mcpServers ?? []
  const mcpConfigPath = mcpServers.length
    ? await writeMcpConfig(mcpServers).catch(() => undefined)
    : undefined
  const args = [
    ...prefix,
    ...buildArgs({
      ...options,
      streamingInput: true,
      mcpConfigPath,
      mcpServerNames: mcpServers.map((server) => server.name),
    }),
  ]

  // Resolved from PATH / settings at runtime, so there is nothing for the
  // bundler to trace — same hint as `lib/cursor-agent.ts` uses.
  const child = spawn(/*turbopackIgnore: true*/ cmd, args, {
    cwd: options.workspace,
    env: { ...process.env, CLAUDE_CODE_SDK_READS_SESSION_STATE: "1" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group: a stop has to reach what the Bash tool started,
    // and a turn's end has to be able to tell that work apart from the
    // server's own processes (`lib/background-processes`).
    ...detachedSpawnOptions,
  })
  trackChildProcess(child)

  // A process that never starts emits `error`, not `exit` — and an unhandled
  // one would surface as a bare errno with no hint at what was being spawned.
  const failure: { error?: NodeJS.ErrnoException } = {}
  child.once("error", (err: NodeJS.ErrnoException) => {
    failure.error = err
  })

  // Registered now, not after the read loop: a process that fails to start has
  // already emitted both events by then, and a listener added late would wait
  // forever for one that will not come again.
  const exited = new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 1))
    child.once("error", () => resolve(1))
  })

  // Decoding per chunk would tear a multi-byte character in half wherever the
  // pipe happened to break; the stream's own decoder holds the tail back until
  // the rest of the sequence arrives.
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")

  const stderrChunks: string[] = []
  child.stderr?.on("data", (chunk: string) => {
    stderrChunks.push(chunk)
  })

  const onAbort = () => killProcessTree(child)
  options.signal?.addEventListener("abort", onAbort)
  if (options.signal?.aborted) onAbort()

  const queue = new AsyncEventQueue<string | AgentStreamEvent>()
  const requestTools = new UnfinishedTools()
  const send = (value: unknown) => {
    if (child.stdin?.writable && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`)
  }
  const control = new ClaudeCodeControl({ send, emit: (event) => queue.push(event),
    askUser: options.askUser, permissionMode: options.permissionMode })
  let initTimer: ReturnType<typeof setTimeout> | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let backgroundWaitTimer: ReturnType<typeof setTimeout> | undefined

  try {
    // Streaming stdin stays open for permission responses until the turn settles.
    child.stdin?.on("error", () => {
      /* the process died before the prompt landed; exit handling reports it */
    })

    if (!child.stdout) {
      yield { type: "error", message: "Claude Code produced no stdout" }
      return
    }

    const translator = new ClaudeCodeTranslator()
    // The CLI's JSONL framing is LF-only: a generic line reader (Node's
    // `readline` included) also splits on U+2028/U+2029, which are legal
    // inside JSON strings and would tear records apart.
    const lines = new LineBuffer()

    const initializeId = "agent-ui-initialize"
    let initialized = false
    let sawResult = false
    let sessionState: unknown
    const backgroundTasks = new Set<string>()
    const closeInput = () => {
      if (sawResult && backgroundTasks.size === 0 &&
        (sessionState === undefined || sessionState === "idle")) child.stdin?.end()
    }
    initTimer = setTimeout(() => {
      queue.push({ type: "error", message: "Claude Code initialization timed out" })
      killProcessTree(child)
    }, 60_000)
    send({ type: "control_request", request_id: initializeId,
      request: { subtype: "initialize", hooks: null, forwardSubagentText: true } })

    // Read independently of permission callbacks: a CLI cancellation or exit must
    // still be consumed while the user has a form open.
    const read = (async () => {
      try {
        for await (const chunk of readStdout(child.stdout!)) queue.push(chunk)
      } finally {
        await control.close()
        queue.close()
      }
    })()

    const mapLine = (line: string): AgentStreamEvent[] => {
      const event = parseCliLine(line)
      if (!event) return []
      const raw = event as unknown as Record<string, unknown>
      if (raw.type === "control_response") {
        const response = raw.response as { request_id?: string; subtype?: string; error?: string } | undefined
        if (response?.request_id === initializeId && !initialized) {
          clearTimeout(initTimer)
          if (response.subtype === "error") {
            killProcessTree(child)
            return [{ type: "error", message: response.error || "Claude Code initialization failed" }]
          }
          initialized = true
          send(claudeUserMessage(options.prompt, options.images))
        }
        return []
      }
      if (control.handle(raw)) {
        clearTimeout(backgroundWaitTimer)
        return []
      }
      if (raw.type === "system" && raw.subtype === "session_state_changed") {
        sessionState = raw.state
        if (sessionState === "requires_action" || sessionState === "idle") clearTimeout(backgroundWaitTimer)
        closeInput()
      }
      if (raw.type === "system" && raw.subtype === "task_started" &&
        ["local_agent", "local_workflow"].includes(String(raw.task_type)) && typeof raw.task_id === "string") {
        backgroundTasks.add(raw.task_id)
      }
      if (raw.type === "system" && raw.subtype === "task_notification" && typeof raw.task_id === "string") {
        backgroundTasks.delete(raw.task_id)
        // Older CLIs have no idle marker. Allow their completion-triggered
        // follow-up to start before deciding the stream is finished.
        clearTimeout(settleTimer)
        settleTimer = setTimeout(closeInput, 1_500)
      }
      if (!raw.parent_tool_use_id && (raw.type === "assistant" ||
        (raw.type === "stream_event" && event.event?.type === "message_start"))) {
        sawResult = false
        clearTimeout(backgroundWaitTimer)
      }
      if (raw.type === "result") {
        sawResult = true
        closeInput()
        if (backgroundTasks.size || (sessionState !== undefined && sessionState !== "idle")) {
          // Match the CLI's default idle ceiling while keeping stdin available
          // to native children. Active work and user interactions clear it.
          const configured = Number(process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ?? 600_000)
          const ceiling = Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 2 ** 31 - 1) : 600_000
          clearTimeout(backgroundWaitTimer)
          if (ceiling > 0) backgroundWaitTimer = setTimeout(() => {
            queue.push({ type: "error", message: "Claude Code background work did not settle before its idle timeout" })
            killProcessTree(child)
          }, ceiling)
        }
      }
      return translator.translate(event).map(interactiveClaudeEvent)
    }

    // A turn can also end without the CLI ever saying so: a rejected usage
    // window parks it inside the subprocess with no result to come. The
    // translator raises `stopRequested` for that, and every other way out —
    // an abort, a failed spawn, a non-zero exit, a stream that simply stopped
    // — goes through `finish`, so the rows a tool opened are always closed.
    let parked = false

    for await (const chunk of queue) {
      if (options.signal?.aborted) break
      if (typeof chunk !== "string") {
        requestTools.track(chunk)
        yield chunk
        continue
      }
      for (const line of lines.push(chunk)) {
        yield* mapLine(line)
      }
      if (translator.stopRequested) {
        parked = true
        break
      }
    }
    await control.close()
    yield* requestTools.finish()
    clearTimeout(initTimer)
    if (!parked && !options.signal?.aborted) {
      const tail = lines.finish()
      if (tail !== null) yield* mapLine(tail)
    }

    // What the CLI said its own window was beats the static guess in the
    // model list, for both the id the user picked and the one it resolved to.
    rememberContextWindow(
      [options.model, translator.model],
      translator.contextWindow
    )

    if (parked) {
      // Nothing more is coming; the `error` the translator already emitted is
      // the turn's outcome, and the subprocess is only holding the pipe open.
      endClaude(child, options)
      yield* translator.finish(false)
      yield { type: "done", durationMs: Date.now() - startedAt }
      return
    }

    const exitCode = await exited
    await read

    if (options.signal?.aborted) {
      yield* translator.finish(false)
      return
    }

    if (failure.error) {
      yield* translator.finish(false)
      yield {
        type: "error",
        message: describeSpawnFailure(failure.error, command),
      }
      return
    }

    // A `result` line is the CLI's own verdict on the turn, failures included,
    // and the translator has already reported it. Only a run that never got
    // that far — a rejected flag, a crash, a missing login — needs its exit
    // code explained here.
    if (!translator.sawResult) {
      if (exitCode !== 0) {
        yield* translator.finish(false)
        yield {
          type: "error",
          message: truncate(
            stderrChunks.join("").trim() || `claude exited with code ${exitCode}`
          ),
        }
        return
      }
      // Exited cleanly with nothing to say — still close the turn.
      yield* translator.finish(true)
      yield { type: "done", durationMs: Date.now() - startedAt }
      return
    }
    yield* translator.finish(true)
  } finally {
    clearTimeout(initTimer)
    clearTimeout(settleTimer)
    clearTimeout(backgroundWaitTimer)
    await control.close()
    options.signal?.removeEventListener("abort", onAbort)
    endClaude(child, options)
  }
}

/**
 * A stopped turn takes everything down; one that ended lets the CLI go and
 * keeps whatever the agent meant to leave running.
 */
function endClaude(child: ChildProcess, options: ClaudeCodeRunOptions) {
  if (options.signal?.aborted) killProcessTree(child)
  else if (options.processes) options.processes.release(child)
  else killClaude(child)
}

/**
 * A stream torn down by a failed spawn rejects; the `error` event carries the
 * real reason, so swallow the tear-down and let the caller report that.
 */
async function* readStdout(stdout: NodeJS.ReadableStream): AsyncGenerator<string> {
  try {
    // Strings, not Buffers: the stream was given an encoding after the spawn.
    yield* stdout as AsyncIterable<string>
  } catch {
    /* reported from the child's `error` event instead */
  }
}

/** Turns an errno into something the user can act on. */
function describeSpawnFailure(
  err: NodeJS.ErrnoException,
  command: ClaudeCodeCommand
): string {
  const target = [command.cmd, ...command.args].join(" ")
  const settings = "Settings → Harnesses → Claude Code"
  if (err.code === "EINVAL" && process.platform === "win32") {
    return `Could not start Claude Code: Node refuses to spawn a .cmd shim directly. Point ${settings} at a claude.exe or at the CLI's own entry point.`
  }
  if (err.code === "ENOENT") {
    return `claude not found — tried ${target}. Install it with \`npm i -g @anthropic-ai/claude-code\` or set its path in ${settings}.`
  }
  if (err.code === "EACCES") {
    return `${target} is not executable. Check its permissions or set another path in ${settings}.`
  }
  return `Could not start Claude Code (${err.code ?? "spawn failed"}): ${err.message} — tried ${target}`
}

function truncate(value: string) {
  return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…` : value
}

function killClaude(child: ChildProcess) {
  if (child.exitCode != null || child.signalCode) return
  try {
    child.kill("SIGTERM")
  } catch {
    /* already gone */
  }
}

/**
 * `--mcp-config` takes a path or inline JSON; a path, because the bridge token
 * is in the headers and argv is world-readable. One file per distinct config
 * under the app's data directory, owner-only, rewritten in place.
 */
async function writeMcpConfig(servers: McpServerConfig[]): Promise<string> {
  const json = mcpConfigJson(servers)
  const dir = join(/*turbopackIgnore: true*/ dataDir(), "mcp")
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const name = createHash("sha256").update(json).digest("hex").slice(0, 16)
  const file = join(/*turbopackIgnore: true*/ dir, `claude-code-${name}.json`)
  await writeFile(file, json, { mode: 0o600 })
  return file
}
