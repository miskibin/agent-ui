import type {
  AgentStreamEvent,
  AgentTokenUsage,
} from "@/lib/cursor-agent-types"
import { exitCodeFrom } from "@/lib/providers/exit-code"
import {
  USER_REQUEST_TOOL,
  type UserRequest,
  type UserRequestAnswer,
} from "@/lib/turn-requests"

/**
 * The pure half of the pi harness: the argv that asks for an RPC session, the
 * commands written to its stdin, and what its events mean. It imports nothing
 * `node --test` cannot load, which is what makes `tests/pi-stream.test.ts`
 * possible; `lib/pi-agent.ts` owns the subprocess around it.
 *
 * RPC mode rather than `--mode json` because json mode is one-way: an
 * extension that wants to ask the user blocks forever on an answer that mode
 * never sends, which is why the harness used to run with no extensions at all.
 * Over RPC the same dialog arrives as an `extension_ui_request` this client
 * can answer, so the model can stop mid-turn, ask, and carry on in the *same*
 * run.
 */

const MAX_FIELD = 50_000

export type PiArgsOptions = {
  model: string
  sessionDir: string
  /** pi session id to continue; absent starts a new one. */
  sessionId?: string
  /** pi thinking level: off | minimal | low | medium | high | xhigh | max. */
  thinking?: string
  /** Our generated ask-user extension, loaded explicitly past discovery. */
  extensionPath?: string
}

/**
 * `--no-extensions` turns *discovery* off — the user's own `~/.pi` extensions,
 * every one of which is context the model would pay for — while an explicit
 * `--extension` still loads. That pairing is the whole point: exactly one
 * extension, ours, and nothing else.
 */
export function buildPiArgs(options: PiArgsOptions): string[] {
  const args = [
    "--mode",
    "rpc",
    "--model",
    options.model,
    "--session-dir",
    options.sessionDir,
    "--no-extensions",
    "--no-themes",
  ]
  if (options.extensionPath) args.push("--extension", options.extensionPath)
  if (options.sessionId) args.push("--session-id", options.sessionId)
  if (options.thinking) args.push("--thinking", options.thinking)
  return args
}

export type PiImage = { type: "image"; data: string; mimeType: string }

/** The one command that starts a turn. Images ride along with the prompt. */
export function promptCommand(prompt: string, images?: PiImage[]) {
  return {
    id: "prompt",
    type: "prompt",
    message: prompt,
    ...(images?.length ? { images } : null),
  }
}

/** Asked once per run: RPC mode has no session header line to read it off. */
export const STATE_COMMAND = { id: "state", type: "get_state" }

export const ABORT_COMMAND = { type: "abort" }

/** One JSONL record, LF-framed with an optional CR the writer left behind. */
export function parsePiLine(line: string): PiEvent | null {
  const trimmed = line.replace(/\r$/, "").trim()
  if (!trimmed.startsWith("{")) return null
  try {
    return JSON.parse(trimmed) as PiEvent
  } catch {
    return null
  }
}

type AssistantDelta = {
  type?: string
  delta?: string
  id?: string
  toolName?: string
}

export type PiEvent = {
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
  willRetry?: boolean
  /** `response` records. */
  command?: string
  success?: boolean
  data?: unknown
  /** `extension_ui_request` records. */
  method?: string
  title?: string
  options?: unknown
  placeholder?: string
  prefill?: string
  timeout?: number
  notifyType?: string
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

/** A dialog pi is blocked on until this client answers it. */
export type PiDialog = {
  /** pi's own request id — the response has to carry it back verbatim. */
  id: string
  method: "select" | "confirm" | "input" | "editor"
  request: UserRequest
  /**
   * Milliseconds after which pi resolves the dialog itself. The client does
   * not have to enforce it, but it *does* have to stop waiting: nobody will
   * ever answer a dialog the agent has already moved past.
   */
  timeout?: number
}

export type PiTranslation = {
  events: AgentStreamEvent[]
  /** Answer this before pi will do anything else. */
  dialog?: PiDialog
  /** `agent_settled` — the run is over, retries and all. */
  settled?: boolean
  /** `agent_end` with nothing pending — the fallback for a missing settle. */
  runEnded?: boolean
}

const NOTHING: PiTranslation = { events: [] }

/**
 * One pi RPC stream, translated. Stateful only where the protocol is: the
 * session id arrives in a command response rather than an event, usage and a
 * failed model call are read off the last message, and a dialog needs to know
 * which tool call it interrupted.
 */
export class PiTranslator {
  private emittedSession = false
  private openTool: { name: string; input?: unknown } | undefined
  /**
   * pi counts tokens per assistant message, and one run here is a whole agent
   * loop. The last message is the one whose prompt carried everything the loop
   * accumulated — the system prompt, the tool schemas, every file it read — so
   * it, not the first, is what the next turn has to fit beside.
   */
  lastUsage: AgentTokenUsage | undefined
  /**
   * A model call that fails is reported *inside* pi's message — the process
   * still exits 0 — so an unreported one ends the turn on `done` with an empty
   * answer and nothing to explain it. It is held rather than yielded because
   * pi auto-retries: a failed attempt that a later one recovers from must not
   * surface as an error, so this is only used when the run produced no text.
   */
  lastMessageError: string | undefined

  translate(event: PiEvent): PiTranslation {
    if (event.type === "response") return this.response(event)
    if (event.type === "extension_ui_request") return this.extensionUi(event)
    if (event.type === "agent_settled") return { events: [], settled: true }
    if (event.type === "agent_end") {
      return { events: [], runEnded: event.willRetry !== true }
    }
    if (event.type === "message_end") {
      const message = asMessage(event.message)
      if (message?.stopReason === "error") {
        this.lastMessageError = describeMessageError(message)
      }
      const usage = toUsage(message?.usage)
      if (usage) this.lastUsage = usage
      return NOTHING
    }
    return { events: this.stream(event) }
  }

  /** The only response we read: `get_state`, for the session id to resume. */
  private response(event: PiEvent): PiTranslation {
    if (event.command !== "get_state" || this.emittedSession) return NOTHING
    const data = event.data
    const sessionId =
      data && typeof data === "object"
        ? (data as { sessionId?: unknown }).sessionId
        : undefined
    if (typeof sessionId !== "string" || !sessionId) return NOTHING
    this.emittedSession = true
    return { events: [{ type: "session", sessionId }] }
  }

  private extensionUi(event: PiEvent): PiTranslation {
    // Fire-and-forget methods expect no answer. A notification is the one with
    // something to say; the rest describe a terminal this app does not have.
    if (event.method === "notify") {
      const text = typeof event.message === "string" ? event.message.trim() : ""
      return text
        ? { events: [{ type: "status", stage: "loading", text: truncate(text) }] }
        : NOTHING
    }
    const dialog = toDialog(event, this.openTool)
    return dialog ? { events: [], dialog } : NOTHING
  }

  /** The events that map straight onto the shared protocol. */
  private stream(event: PiEvent): AgentStreamEvent[] {
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
      // Held so a dialog raised from inside this tool can say which one it is.
      this.openTool = { name: event.toolName ?? "tool", input: event.args }
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
      this.openTool = undefined
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
}

/** `extension_ui_request` → the app's own vocabulary for asking the user. */
export function toDialog(
  event: PiEvent,
  tool?: { name: string; input?: unknown }
): PiDialog | null {
  const id = event.id
  if (typeof id !== "string" || !id) return null
  const title = typeof event.title === "string" ? event.title.trim() : ""
  const description =
    typeof event.message === "string" && event.message.trim()
      ? event.message.trim()
      : undefined
  const base = {
    id,
    title: title || "The agent has a question",
    ...(description ? { description } : null),
    ...(tool ? { tool } : null),
  }
  const timeout =
    typeof event.timeout === "number" && event.timeout > 0
      ? event.timeout
      : undefined

  if (event.method === "select") {
    // pi answers a select with the option *string* it was given, so the label
    // has to be the id — there is nothing else to send back.
    const options = (Array.isArray(event.options) ? event.options : [])
      .filter((option): option is string => typeof option === "string" && !!option.trim())
      .map((option) => ({ id: option, label: option }))
    if (options.length === 0) return null
    return { id, method: "select", timeout, request: { ...base, kind: "select", options } }
  }

  if (event.method === "confirm") {
    return {
      id,
      method: "confirm",
      timeout,
      request: {
        ...base,
        kind: "confirm",
        options: [
          { id: CONFIRM_YES, label: "Yes" },
          { id: CONFIRM_NO, label: "No" },
        ],
      },
    }
  }

  if (event.method === "input" || event.method === "editor") {
    // An editor's `prefill` is a starting value rather than a hint, but a
    // free-text answer is all either method can carry back.
    const placeholder =
      typeof event.placeholder === "string" && event.placeholder.trim()
        ? event.placeholder.trim()
        : typeof event.prefill === "string" && event.prefill.trim()
          ? event.prefill.trim()
          : undefined
    return {
      id,
      method: event.method,
      timeout,
      request: {
        ...base,
        kind: "input",
        ...(placeholder ? { placeholder } : null),
      },
    }
  }

  // setStatus / setWidget / setTitle / set_editor_text describe a terminal
  // this app does not have, and expect no answer either way.
  return null
}

export const CONFIRM_YES = "yes"
export const CONFIRM_NO = "no"

/** What goes back on stdin so pi's blocked extension can continue. */
export function dialogResponse(
  dialog: PiDialog,
  answer: UserRequestAnswer | null
) {
  const base = { type: "extension_ui_response", id: dialog.id }
  if (!answer || answer.cancelled) return { ...base, cancelled: true }
  if (dialog.method === "confirm") {
    if (!answer.optionId) return { ...base, cancelled: true }
    return { ...base, confirmed: answer.optionId === CONFIRM_YES }
  }
  // A select carries its labels as ids, so either field is a usable answer —
  // and a UI that lets someone type past the options still gets through.
  const value =
    dialog.method === "select"
      ? (answer.optionId ?? answer.text)
      : (answer.text ?? answer.optionId)
  if (typeof value !== "string") return { ...base, cancelled: true }
  return { ...base, value }
}

export type DialogOutcome = { status: "done" | "error"; output: string }

/** How the `question` row reads once the wait is over. */
export function dialogOutcome(
  dialog: PiDialog,
  answer: UserRequestAnswer | null,
  reason?: "no-channel" | "timeout" | "gone"
): DialogOutcome {
  if (reason === "no-channel") {
    return {
      status: "error",
      output: "Cancelled — this run has no way to ask the user.",
    }
  }
  if (reason === "timeout") {
    return { status: "error", output: "The agent stopped waiting for an answer." }
  }
  if (reason === "gone") {
    return { status: "error", output: "The run ended before this was answered." }
  }
  if (!answer || answer.cancelled) {
    return { status: "done", output: "Cancelled by the user." }
  }
  if (dialog.method === "confirm") {
    if (!answer.optionId) return { status: "done", output: "Cancelled by the user." }
    return {
      status: "done",
      output: answer.optionId === CONFIRM_YES ? "Confirmed." : "Declined.",
    }
  }
  const value =
    dialog.method === "select"
      ? (answer.optionId ?? answer.text)
      : (answer.text ?? answer.optionId)
  if (typeof value !== "string" || !value.trim()) {
    return { status: "done", output: "Cancelled by the user." }
  }
  return {
    status: "done",
    output:
      dialog.method === "select"
        ? `Selected: ${truncate(value.trim())}`
        : `Answered: ${truncate(value.trim())}`,
  }
}

/** The pair of `tool` events a wait is published as, running then settled. */
export function questionRow(
  dialog: PiDialog,
  outcome?: DialogOutcome
): AgentStreamEvent {
  const id = `question:${dialog.id}`
  if (!outcome) {
    return {
      type: "tool",
      id,
      name: USER_REQUEST_TOOL,
      status: "running",
      input: stringify(dialog.request),
    }
  }
  return {
    type: "tool",
    id,
    name: USER_REQUEST_TOOL,
    status: outcome.status,
    input: stringify(dialog.request),
    output: outcome.output,
  }
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
export function describeMessageError(message: {
  errorMessage?: string
}): string {
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
    const next =
      (value as { error?: unknown }).error ?? (value as { message?: unknown }).message
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

export function truncate(value: string) {
  return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…` : value
}
