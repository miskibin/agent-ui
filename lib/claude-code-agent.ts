import "server-only"

import { spawn, type ChildProcess } from "node:child_process"

import {
  buildArgs,
  ClaudeCodeTranslator,
  parseCliLine,
} from "@/lib/claude-code-protocol"
import {
  resolveClaudeCodeCommand,
  type ClaudeCodeCommand,
} from "@/lib/claude-code-runtime"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import type { PermissionMode } from "@/lib/providers/types"
import { LineBuffer } from "@/lib/stream-framing"

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
  permissionMode: PermissionMode
  workspace: string
  binPath?: string
  signal?: AbortSignal
}

const MAX_FIELD = 50_000

export async function* runClaudeCodeAgent(
  options: ClaudeCodeRunOptions
): AsyncGenerator<AgentStreamEvent> {
  const startedAt = Date.now()
  const command = resolveClaudeCodeCommand(options.binPath)
  const { cmd, args: prefix } = command
  const args = [...prefix, ...buildArgs(options)]

  // Resolved from PATH / settings at runtime, so there is nothing for the
  // bundler to trace — same hint as `lib/cursor-agent.ts` uses.
  const child = spawn(/*turbopackIgnore: true*/ cmd, args, {
    cwd: options.workspace,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })

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

  const stderrChunks: string[] = []
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(String(chunk))
  })

  const onAbort = () => killClaude(child)
  options.signal?.addEventListener("abort", onAbort)

  try {
    // The prompt goes here rather than in argv — see `buildArgs`. The CLI also
    // tears down background shells only once the result is out *and* stdin has
    // closed, so ending it is part of a clean exit, not an optimisation.
    child.stdin?.on("error", () => {
      /* the process died before the prompt landed; exit handling reports it */
    })
    child.stdin?.end(options.prompt)

    if (!child.stdout) {
      yield { type: "error", message: "Claude Code produced no stdout" }
      return
    }

    const translator = new ClaudeCodeTranslator()
    // The CLI's JSONL framing is LF-only: a generic line reader (Node's
    // `readline` included) also splits on U+2028/U+2029, which are legal
    // inside JSON strings and would tear records apart.
    const lines = new LineBuffer()

    const mapLine = (line: string): AgentStreamEvent[] => {
      const event = parseCliLine(line)
      return event ? translator.translate(event) : []
    }

    for await (const chunk of readStdout(child.stdout)) {
      if (options.signal?.aborted) break
      for (const line of lines.push(String(chunk))) {
        yield* mapLine(line)
      }
    }
    const tail = lines.finish()
    if (tail !== null) yield* mapLine(tail)

    const exitCode = await exited

    if (options.signal?.aborted) return

    if (failure.error) {
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
        yield {
          type: "error",
          message: truncate(
            stderrChunks.join("").trim() || `claude exited with code ${exitCode}`
          ),
        }
        return
      }
      // Exited cleanly with nothing to say — still close the turn.
      yield { type: "done", durationMs: Date.now() - startedAt }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
    killClaude(child)
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
