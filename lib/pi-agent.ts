import "server-only"

import { spawn, type ChildProcess } from "node:child_process"

import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import {
  ABORT_COMMAND,
  buildPiArgs,
  dialogOutcome,
  dialogResponse,
  parsePiLine,
  PiTranslator,
  promptCommand,
  questionRow,
  STATE_COMMAND,
  truncate,
  type PiDialog,
  type PiImage,
} from "@/lib/pi-protocol"
import { resolvePiCommand, type PiCommand } from "@/lib/pi-runtime"
import { LineBuffer } from "@/lib/stream-framing"
import type { AskUser, UserRequestAnswer } from "@/lib/turn-requests"

/**
 * Spawns the `pi` CLI in `--mode rpc` and translates its event stream into the
 * shared `AgentStreamEvent` protocol.
 *
 * pi is an agent whose whole loop runs inside the subprocess, so one call here
 * is one full turn: the events below interleave assistant text with the tool
 * calls pi made along the way. `lib/pi-protocol` owns what those events mean
 * and what argv asks for them; this file owns the process — stdin, the JSONL
 * framing, aborts, the wait while a dialog is open, and a binary that dies
 * without ever saying why.
 *
 * One process per turn, as before. RPC only changes how it is talked to: the
 * prompt goes over stdin instead of argv, so the run can also answer the
 * extension dialogs json mode left hanging.
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
  /** Our generated ask-user extension; absent means the model cannot ask. */
  extensionPath?: string
  images?: PiImage[]
  /** Where a mid-turn question goes. Absent = every request is cancelled. */
  askUser?: AskUser
  binPath?: string
  signal?: AbortSignal
}

/**
 * How long a run that has ended without saying `agent_settled` is given to say
 * it. Every pi that emits `agent_end` follows it within microseconds, so this
 * only ever fires for a CLI that does not send the settle event at all — which
 * would otherwise leave the turn hanging on a process that is finished.
 */
const SETTLE_GRACE_MS = 1_500

export async function* runPiAgent(
  options: PiRunOptions
): AsyncGenerator<AgentStreamEvent> {
  const startedAt = Date.now()
  const command = resolvePiCommand(options.binPath)
  const { cmd, args: prefix } = command
  const args = [
    ...prefix,
    ...buildPiArgs({
      model: options.model,
      sessionDir: options.sessionDir,
      sessionId: options.sessionId,
      thinking: options.thinking,
      extensionPath: options.extensionPath,
    }),
  ]

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
    stdio: ["pipe", "pipe", "pipe"],
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

  // Decoding per chunk would tear a multi-byte character in half wherever the
  // pipe happened to break; the stream's own decoder holds the tail back until
  // the rest of the sequence arrives.
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")

  const stderrChunks: string[] = []
  child.stderr?.on("data", (chunk: string) => {
    stderrChunks.push(chunk)
  })

  // A process that died before a command landed reports itself through `close`
  // and `error`; a raw EPIPE here would take the whole route down instead.
  child.stdin?.on("error", () => {
    /* reported from the child's own events */
  })
  const send = (value: unknown) => {
    if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  const onAbort = () => {
    // Best effort: pi tears its own tool subprocesses down on an abort, and
    // gets the signal below either way.
    send(ABORT_COMMAND)
    killPi(child)
  }
  options.signal?.addEventListener("abort", onAbort)

  let sawError = false
  let sawText = false
  const translator = new PiTranslator()

  try {
    if (!child.stdout) {
      yield { type: "error", message: "pi produced no stdout" }
      return
    }

    // RPC mode has no session header line — json mode's first record — so the
    // id to resume with has to be asked for. Both commands are written up
    // front: pi handles them in order and `prompt` returns before the run
    // starts, so this costs no round trip.
    send(STATE_COMMAND)
    send(promptCommand(options.prompt, options.images))

    const note = (event: AgentStreamEvent) => {
      if (event.type === "error") sawError = true
      if (event.type === "text" && event.text.trim()) sawText = true
      return event
    }

    /**
     * Publishes the wait, waits, answers pi, and closes the row.
     *
     * A generator rather than a list on purpose: the "running" row has to be
     * on the wire *before* the wait, or the only thing the user ever sees is a
     * question that was already answered.
     */
    const answer = async function* (dialog: PiDialog) {
      yield questionRow(dialog)
      if (!options.askUser) {
        send(dialogResponse(dialog, { cancelled: true }))
        yield questionRow(dialog, dialogOutcome(dialog, null, "no-channel"))
        return
      }
      // Whichever settles first wins: the person, the clock pi told us it is
      // running, an abort, or the process going away. Only an answer is worth
      // writing back — pi has already moved on from the other three.
      const races: Array<Promise<Settlement>> = [
        options.askUser(dialog.request).then(
          (value): Settlement => ({ kind: "answer", value }),
          (): Settlement => ({ kind: "gone" })
        ),
        exited.then((): Settlement => ({ kind: "gone" })),
      ]
      if (dialog.timeout) {
        races.push(delay(dialog.timeout).then((): Settlement => ({ kind: "timeout" })))
      }
      if (options.signal) {
        races.push(aborted(options.signal).then((): Settlement => ({ kind: "gone" })))
      }
      const outcome = await Promise.race(races)
      if (outcome.kind !== "answer") {
        yield questionRow(dialog, dialogOutcome(dialog, null, outcome.kind))
        return
      }
      send(dialogResponse(dialog, outcome.value))
      yield questionRow(dialog, dialogOutcome(dialog, outcome.value))
    }

    // Two flags the translation sets and the loop reads: the run is over, and
    // the run said so the older way and is owed a moment to say it properly.
    const state: { settled: boolean; grace: Promise<GRACE> | null } = {
      settled: false,
      grace: null,
    }

    /**
     * One record in, the events it means out — with the dialog wait folded in,
     * because answering a dialog is the one translation that has to leave the
     * process running and wait for a human.
     */
    const translate = async function* (line: string) {
      const parsed = parsePiLine(line)
      if (!parsed) return
      const result = translator.translate(parsed)
      for (const event of result.events) yield note(event)
      if (result.settled) state.settled = true
      // `agent_end` normally precedes `agent_settled` by microseconds. Arming
      // the clock rather than stopping here keeps a retry or a queued
      // continuation working on every pi that does send the settle event.
      if (result.runEnded && !state.settled) {
        state.grace ??= delay(SETTLE_GRACE_MS).then(() => GRACE)
      }
      if (result.dialog) {
        for await (const event of answer(result.dialog)) yield note(event)
      }
    }

    // pi's JSONL framing is LF-only: a generic line reader (Node's `readline`
    // included) also splits on U+2028/U+2029, which are legal inside JSON
    // strings and would tear records apart.
    const lines = new LineBuffer()
    const iterator = child.stdout[Symbol.asyncIterator]() as AsyncIterator<string>
    // A stream torn down by a failed spawn rejects; the `error` event carries
    // the real reason, so an end-of-stream here lets the caller report that.
    const read = () => iterator.next().catch(() => DONE)
    let pending: Promise<IteratorResult<string>> | null = null
    let ended = false

    while (!state.settled && !ended) {
      pending ??= read()
      // Only a run that has ended without settling races a clock; every other
      // read waits for the next chunk for as long as it takes, which is what
      // lets a dialog stay open until the person answers it.
      const step = state.grace
        ? await Promise.race([pending, state.grace])
        : await pending
      if (step === GRACE) break
      pending = null
      if (step.done || options.signal?.aborted) break

      for (const line of lines.push(step.value)) {
        for await (const event of translate(line)) yield event
        if (state.settled) {
          ended = true
          break
        }
      }
    }

    // A line left in the buffer when stdout ended is still a record.
    if (!state.settled && !options.signal?.aborted) {
      const tail = lines.finish()
      if (tail !== null) {
        for await (const event of translate(tail)) yield event
      }
    }

    // Closing stdin is how an RPC session is asked to shut down; without it pi
    // waits for another command that is never coming. Whatever it writes on
    // the way out is drained rather than read: an unread pipe would block the
    // process we are waiting on.
    child.stdin?.end()
    child.stdout.resume()

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

    if (translator.lastMessageError && !sawText) {
      yield { type: "error", message: translator.lastMessageError }
      return
    }

    yield {
      type: "done",
      durationMs: Date.now() - startedAt,
      ...(translator.lastUsage ? { usage: translator.lastUsage } : null),
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
    child.stdin?.end()
    killPi(child)
  }
}

type Settlement =
  | { kind: "answer"; value: UserRequestAnswer }
  | { kind: "timeout" }
  | { kind: "gone" }

/** The loser of the settle race, distinguishable from an iterator result. */
const GRACE = Symbol("pi-settle-grace")
type GRACE = typeof GRACE

const DONE: IteratorResult<string> = { done: true, value: undefined }

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // A pending timer would hold a serverless invocation open past the answer.
    timer.unref?.()
  })
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
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

function killPi(child: ChildProcess) {
  if (child.exitCode != null || child.signalCode) return
  try {
    child.kill("SIGTERM")
  } catch {
    /* already gone */
  }
}
