import "server-only"

import { spawn, type ChildProcess } from "node:child_process"

import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import { resolvePiCommand } from "@/lib/pi-runtime"

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
  message?: unknown
}

export async function* runPiAgent(
  options: PiRunOptions
): AsyncGenerator<AgentStreamEvent> {
  const startedAt = Date.now()
  const { cmd, args: prefix } = resolvePiCommand(options.binPath)
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

  const stderrChunks: string[] = []
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(String(chunk))
  })

  const onAbort = () => killPi(child)
  options.signal?.addEventListener("abort", onAbort)

  let sawError = false

  try {
    if (!child.stdout) {
      yield { type: "error", message: "pi produced no stdout" }
      return
    }

    // pi's JSONL framing is LF-only: a generic line reader (Node's `readline`
    // included) also splits on U+2028/U+2029, which are legal inside JSON
    // strings and would tear records apart.
    let buffer = ""
    let emittedSession = false

    for await (const chunk of child.stdout) {
      if (options.signal?.aborted) break
      buffer += String(chunk)
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, "").trim()
        if (!trimmed.startsWith("{")) continue
        let event: PiEvent
        try {
          event = JSON.parse(trimmed) as PiEvent
        } catch {
          continue
        }
        if (event.type === "session" && !emittedSession && event.id) {
          emittedSession = true
          yield { type: "session", sessionId: event.id }
          continue
        }
        for (const mapped of mapEvent(event)) {
          if (mapped.type === "error") sawError = true
          yield mapped
        }
      }
    }

    const exitCode: number = await new Promise((resolve) => {
      if (child.exitCode != null) {
        resolve(child.exitCode)
        return
      }
      child.once("close", (code) => resolve(code ?? 1))
    })

    if (options.signal?.aborted) return

    if (exitCode !== 0) {
      yield {
        type: "error",
        message: truncate(
          stderrChunks.join("").trim() || `pi exited with code ${exitCode}`
        ),
      }
      return
    }

    if (!sawError) yield { type: "done", durationMs: Date.now() - startedAt }
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
    killPi(child)
  }
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
    return [
      {
        type: "tool",
        id: event.toolCallId,
        name: event.toolName ?? "tool",
        status: event.isError ? "error" : "done",
        output: toolOutput(event.result),
      },
    ]
  }

  if (event.type === "extension_error") {
    const message = stringify(event.error ?? event.message)
    return message ? [{ type: "error", message }] : []
  }

  return []
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
