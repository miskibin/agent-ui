import "server-only"

import { spawn, type ChildProcess } from "node:child_process"

import type {
  AgentStreamEvent,
  AgentTokenUsage,
} from "@/lib/cursor-agent-types"
import { exitCodeFrom } from "@/lib/providers/exit-code"
import { resolvePiCommand, type PiCommand } from "@/lib/pi-runtime"
import { LineBuffer } from "@/lib/stream-framing"

/**
 * Spawns the `pi` CLI in `--mode json` and translates its event stream into
 * the shared `AgentStreamEvent` protocol.
 *
 * pi is a four-tool agent (read / write / edit / bash) whose whole loop runs
 * inside the subprocess, so one call here is one full agentic turn: the events
 * below interleave assistant text with the tool calls pi made along the way.
 */

export type PiRunOptions = {
  prompt: string
  /** Provider-qualified id, e.g. `ollama/qwen3:8b`. */
  model: string
  /** pi session id to continue; absent starts a new one. */
  sessionId?: string
  /** pi thinking level: off | minimal | low | medium | high | xhigh | max. */
  thinking?: string
  workspace: string
  /** `PI_CODING_AGENT_DIR` — keeps our models.json out of the user's ~/.pi. */
  configDir: string
  sessionDir: string
  binPath?: string
  signal?: AbortSignal
}

const MAX_FIELD = 50_000

type AssistantDelta = {
  type?: string
  delta?: string
  id?: string
  toolName?: string
}

type PiEvent = {
  type?: string
  id?: string
  assistantMessageEvent?: AssistantDelta
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  error?: unknown
  message?: PiMessage | unknown
}

type PiMessage = {
  role?: string
  stopReason?: string
  errorMessage?: string
  usage?: PiUsage
}

type PiUsage = {
  input?: number
  output?: number
}

export async function* runPiAgent(
  options: PiRunOptions
): AsyncGenerator<AgentStreamEvent> {
  const startedAt = Date.now()
  const command = resolvePiCommand(options.binPath)
  const { cmd, args: prefix } = command
  const args = [
    ...prefix,
    "--mode",
    "json",
    "--model",
    options.model,
    "--session-dir",
    options.sessionDir,
    // Extension UI dialogs would block forever waiting on a stdin answer that
    // json mode never sends, and every extension is context the model pays
    // for. The harness stays at pi's four built-in tools.
    "--no-extensions",
    "--no-themes",
  ]

  if (options.sessionId) args.push("--session-id", options.sessionId)
  if (options.thinking) args.push("--thinking", options.thinking)
  args.push("--", options.prompt)

  // Resolved from PATH / settings at runtime, so there is nothing for the
  // bundler to trace — same hint as `lib/cursor-agent.ts` uses.
  const child = spawn(/*turbopackIgnore: true*/ cmd, args, {
    cwd: options.workspace,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: options.configDir,
      // Startup update checks would add seconds to a local-only run.
      PI_OFFLINE: "1",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })

  // A process that never starts emits `error`, not `exit` — and an unhandled
  // one would surface as a bare errno ("spawn EINVAL") with no hint at what
  // was being spawned. The holder keeps it out of narrowing's way.
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

  const stderrChunks: string[] = []
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(String(chunk))
  })

  const onAbort = () => killPi(child)
  options.signal?.addEventListener("abort", onAbort)

  let sawError = false
  let sawText = false
  /**
   * A model call that fails is reported *inside* pi's message — the process
   * still exits 0 — so an unreported one ends the turn on `done` with an empty
   * answer and nothing to explain it. It is held rather than yielded because
   * pi auto-retries: a failed attempt that a later one recovers from must not
   * surface as an error, so this is only used when the turn produced no text.
   */
  let lastMessageError: string | undefined
  /**
   * pi counts tokens per assistant message, and one call here is a whole agent
   * loop. The last message is the one whose prompt carried everything the loop
   * accumulated — the system prompt, the tool schemas, every file it read — so
   * it, not the first, is what the next turn has to fit beside.
   */
  let lastUsage: AgentTokenUsage | undefined

  try {
    if (!child.stdout) {
      yield { type: "error", message: "pi produced no stdout" }
      return
    }

    // pi's JSONL framing is LF-only: a generic line reader (Node's `readline`
    // included) also splits on U+2028/U+2029, which are legal inside JSON
    // strings and would tear records apart.
    const lines = new LineBuffer()
    let emittedSession = false

    const mapLine = (line: string): AgentStreamEvent[] => {
      const trimmed = line.replace(/\r$/, "").trim()
      if (!trimmed.startsWith("{")) return []
      let event: PiEvent
      try {
        event = JSON.parse(trimmed) as PiEvent
      } catch {
        return []
      }
      if (event.type === "session" && !emittedSession && event.id) {
        emittedSession = true
        return [{ type: "session", sessionId: event.id }]
      }
      // `message_start` and `turn_end` repeat the same `stopReason`, so the
      // message's end is the one place this is read.
      if (event.type === "message_end") {
        const message = asMessage(event.message)
        if (message?.stopReason === "error") {
          lastMessageError = describeMessageError(message)
        }
        const usage = toUsage(message?.usage)
        if (usage) lastUsage = usage
        return []
      }
      return mapEvent(event)
    }

    for await (const chunk of readStdout(child.stdout)) {
      if (options.signal?.aborted) break
      for (const line of lines.push(String(chunk))) {
        for (const mapped of mapLine(line)) {
          if (mapped.type === "error") sawError = true
          if (mapped.type === "text" && mapped.text.trim()) sawText = true
          yield mapped
        }
      }
    }
    const tail = lines.finish()
    if (tail !== null) {
      for (const mapped of mapLine(tail)) {
        if (mapped.type === "error") sawError = true
        if (mapped.type === "text" && mapped.text.trim()) sawText = true
        yield mapped
      }
    }

    const exitCode = await exited

    if (options.signal?.aborted) return

    if (failure.error) {
      yield { type: "error", message: describeSpawnFailure(failure.error, command) }
      return
    }

    if (exitCode !== 0) {
      yield {
        type: "error",
        message: truncate(
          stderrChunks.join("").trim() || `pi exited with code ${exitCode}`
        ),
      }
      return
    }

    if (sawError) return

    if (lastMessageError && !sawText) {
      yield { type: "error", message: lastMessageError }
      return
    }

    yield {
      type: "done",
      durationMs: Date.now() - startedAt,
      ...(lastUsage ? { usage: lastUsage } : null),
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
    killPi(child)
  }
}

/**
 * A stream torn down by a failed spawn rejects; the `error` event carries the
 * real reason, so swallow the tear-down and let the caller report that.
 */
async function* readStdout(stdout: NodeJS.ReadableStream) {
  try {
    yield* stdout
  } catch {
    /* reported from the child's `error` event instead */
  }
}

/** Turns an errno into something the user can act on. */
function describeSpawnFailure(
  err: NodeJS.ErrnoException,
  command: PiCommand
): string {
  const target = [command.cmd, ...command.args].join(" ")
  const settings = "Settings → Providers → pi"
  if (err.code === "EINVAL" && process.platform === "win32") {
    return `Could not start pi: Node refuses to spawn a .cmd shim directly. Point ${settings} at pi's own entry point (…\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js) or at a pi.exe.`
  }
  if (err.code === "ENOENT") {
    return `pi not found — tried ${target}. Install it with \`npm i -g @earendil-works/pi-coding-agent\` or set its path in ${settings}.`
  }
  if (err.code === "EACCES") {
    return `${target} is not executable. Check its permissions or set another path in ${settings}.`
  }
  return `Could not start pi (${err.code ?? "spawn failed"}): ${err.message} — tried ${target}`
}

/** One pi event in, zero or more stream events out. */
function mapEvent(event: PiEvent): AgentStreamEvent[] {
  if (event.type === "message_update") {
    const delta = event.assistantMessageEvent
    if (!delta) return []
    if (delta.type === "text_delta" && delta.delta) {
      return [{ type: "text", text: delta.delta }]
    }
    if (delta.type === "thinking_delta" && delta.delta) {
      return [{ type: "thinking", text: delta.delta }]
    }
    // Announce the call as soon as the model names it; `tool_execution_start`
    // fills the arguments in on the same id a moment later.
    if (delta.type === "toolcall_start" && delta.id) {
      return [
        {
          type: "tool",
          id: delta.id,
          name: delta.toolName ?? "tool",
          status: "running",
        },
      ]
    }
    return []
  }

  if (event.type === "tool_execution_start" && event.toolCallId) {
    return [
      {
        type: "tool",
        id: event.toolCallId,
        name: event.toolName ?? "tool",
        status: "running",
        input: stringify(event.args),
      },
    ]
  }

  if (event.type === "tool_execution_end" && event.toolCallId) {
    // pi's tool results are free-form; a bash tool that publishes an exit code
    // does so in there, and one that does not leaves the field absent.
    const exitCode = exitCodeFrom(event.result)
    return [
      {
        type: "tool",
        id: event.toolCallId,
        name: event.toolName ?? "tool",
        status: event.isError ? "error" : "done",
        output: toolOutput(event.result),
        ...(exitCode === undefined ? null : { exitCode }),
      },
    ]
  }

  if (event.type === "extension_error") {
    const message = stringify(event.error ?? event.message)
    return message ? [{ type: "error", message }] : []
  }

  return []
}

/** Zeroes are pi's placeholder for "not counted yet", not a real count. */
function toUsage(usage: PiUsage | undefined): AgentTokenUsage | undefined {
  if (!usage) return undefined
  const input = typeof usage.input === "number" ? usage.input : 0
  const output = typeof usage.output === "number" ? usage.output : 0
  if (input <= 0 && output <= 0) return undefined
  return { input, output }
}

function asMessage(value: unknown): PiMessage | null {
  return value && typeof value === "object" ? (value as PiMessage) : null
}

/**
 * pi passes the provider's failure through verbatim, and Ollama's OpenAI shim
 * nests the readable sentence two JSON envelopes deep behind an HTTP status.
 * Peel it down to that sentence, and keep the raw string if it is shaped some
 * other way.
 */
function describeMessageError(message: PiMessage): string {
  const raw = message.errorMessage?.trim()
  if (!raw) return "pi: the model call failed"
  const status = /^(\d{3}):\s*/.exec(raw)
  let value: unknown = status ? raw.slice(status[0].length) : raw
  for (let depth = 0; depth < 8; depth++) {
    if (typeof value === "string") {
      const trimmed = value.trim()
      if (!trimmed.startsWith("{")) break
      try {
        value = JSON.parse(trimmed) as unknown
      } catch {
        break
      }
      continue
    }
    if (!value || typeof value !== "object") break
    const next = (value as { error?: unknown }).error ?? (value as { message?: unknown }).message
    if (next == null) break
    value = next
  }
  const text = typeof value === "string" ? value.trim() : ""
  const detail = text || truncate(raw)
  return status ? `pi: ${status[1]} — ${detail}` : `pi: ${detail}`
}

/** Tool results are `{ content: [{ type: "text", text }] }` blocks. */
function toolOutput(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return stringify(result)
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return stringify(result)
  const text = content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""
    )
    .filter(Boolean)
    .join("\n")
  return text ? truncate(text) : undefined
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

function killPi(child: ChildProcess) {
  if (child.exitCode != null || child.signalCode) return
  try {
    child.kill("SIGTERM")
  } catch {
    /* already gone */
  }
}
