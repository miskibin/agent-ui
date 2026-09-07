import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import { exitCodeFrom } from "@/lib/providers/exit-code"
import type {
  AcpContentBlock,
  AcpSessionUpdate,
  AcpSessionUpdateParams,
  AcpToolCallContent,
} from "@/lib/acp-types"

/**
 * The pure half of the ACP client: one `session/update` in, zero or more
 * `AgentStreamEvent`s out, plus the bounding and coalescing that keeps a
 * chatty agent from flooding the stream.
 *
 * It is a separate module from `lib/acp-agent.ts` for the same reason
 * `lib/claude-code-protocol.ts` is separate from `lib/claude-code-agent.ts`:
 * nothing here loads `node:child_process`, and — just as importantly —
 * nothing here imports a *value* out of `lib/acp-types.ts`, whose parameter
 * properties `node --test`'s strip-only loader cannot parse. Types from there
 * are erased at compile time and so are free. That is what makes
 * `tests/acp-tool-updates.test.ts` possible without a build step.
 */

const MAX_FIELD = 50_000
/**
 * Some ACP agents resend the ENTIRE accumulated tool output on every
 * `tool_call_update` rather than a delta, so a redrawing terminal progress bar
 * can balloon one tool call to hundreds of KB per update at several updates a
 * second. What is kept is a bounded *tail*: an update routinely omits `kind`,
 * so there is no reliable way to tell a redrawing terminal from any other tool
 * here, and the end is the useful part of live-growing output either way.
 *
 * Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
 */
const TOOL_OUTPUT_MAX_CHARS = 8_000
const TOOL_OUTPUT_TRUNCATION_MARKER = "[Earlier output truncated]\n\n"

export type AcpToolCallSummary = {
  toolCallId: string
  title?: string
  kind?: string
  rawInput?: unknown
}

/**
 * What `mapAcpUpdate` remembers about a tool call between notifications: the
 * summary the permission handler reads, plus the bookkeeping the coalescing
 * below needs to decide whether the next update is worth emitting.
 */
export type AcpToolCallState = AcpToolCallSummary & {
  status?: "running" | "done" | "error"
  /** The rendered argument payload — `detail`, in ACP's vocabulary. */
  input?: string
  /** The rendered, tail-bounded output. */
  output?: string
  /** Characters of text carried on `rawOutput`'s known fields. */
  rawOutputChars?: number
  /** `toolCallProgressLength` at the last emission, and updates skipped since. */
  emittedProgress?: number
  skippedSinceEmit?: number
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
  tools: Map<string, AcpToolCallState>
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
  tools: Map<string, AcpToolCallState>
): AgentStreamEvent | null {
  const id = update.toolCallId
  if (!id) return null
  const known = tools.get(id)

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
  // The envelope's header is at the *start* of the text, so it has to be read
  // before the tail bound below cuts it off — and past this length the text is
  // not a file read any more, it is a terminal redrawing itself.
  const read = raw && raw.length <= ENVELOPE_MAX_CHARS ? unwrapReadEnvelope(raw) : null
  const output = raw === undefined ? undefined : boundToolOutput(read ? read.body : raw)
  const input = toolInput(update.rawInput, known?.rawInput, read)
  const exitCode = exitCodeFrom(update.rawOutput)

  // An update is a patch, not a whole call: `tool_call_update` omits `title`
  // and `kind`, and a completion routinely omits the content it already sent.
  // Everything absent is carried forward so the state compared below — and the
  // event emitted from it — describes the call and not just this one line.
  const next: AcpToolCallState = {
    toolCallId: id,
    title: update.title ?? known?.title,
    kind: update.kind ?? known?.kind,
    rawInput: update.rawInput ?? known?.rawInput,
    status,
    input: input ?? known?.input,
    output: output ?? known?.output,
    rawOutputChars:
      update.rawOutput === undefined
        ? known?.rawOutputChars
        : rawOutputTextChars(update.rawOutput),
  }

  const decision = decideToolCallUpdateEmission({
    previous: known,
    next,
    lastEmittedProgress: known?.emittedProgress,
    skippedSinceEmit: known?.skippedSinceEmit ?? 0,
  })
  tools.set(id, {
    ...next,
    emittedProgress: decision.emit
      ? toolCallProgressLength(next)
      : known?.emittedProgress,
    skippedSinceEmit: decision.skippedSinceEmit,
  })
  if (!decision.emit) return null

  return {
    type: "tool",
    id,
    name: next.title || "tool",
    status,
    ...(next.input ? { input: next.input } : null),
    ...(next.output ? { output: next.output } : null),
    ...(exitCode === undefined ? null : { exitCode }),
  }
}

/* -------------------------------------------------------------------------- */
/*                        bounding and coalescing updates                     */
/* -------------------------------------------------------------------------- */

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/** The last `TOOL_OUTPUT_MAX_CHARS`, said to be the last. */
export function boundToolOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return text
  return `${TOOL_OUTPUT_TRUNCATION_MARKER}${text.slice(-TOOL_OUTPUT_MAX_CHARS)}`
}

/**
 * `rawOutput` is provider-defined and, for a terminal-shaped tool, carries the
 * same cumulative text as `content`. Only its length is kept here — the field
 * itself is read for an exit code and nothing else — so a chatty provider
 * cannot smuggle unbounded output through it either.
 */
const RAW_OUTPUT_TEXT_FIELDS = ["content", "stdout", "stderr", "output"] as const

export function rawOutputTextChars(rawOutput: unknown): number {
  if (!rawOutput || typeof rawOutput !== "object" || Array.isArray(rawOutput)) {
    return 0
  }
  const record = rawOutput as Record<string, unknown>
  let chars = 0
  for (const field of RAW_OUTPUT_TEXT_FIELDS) {
    const value = record[field]
    if (typeof value === "string") chars += Math.min(value.length, TOOL_OUTPUT_MAX_CHARS)
  }
  return chars
}

/**
 * Even with a bounded tail, a redrawing terminal shifts that tail on nearly
 * every notification, which would put one stream event on the wire per redraw.
 * So an in-progress update is emitted only when it actually says something
 * new: a terminal status, a changed title or status, output that grew by a
 * paragraph, or enough skipped updates that the row has gone quiet for too
 * long. A completion is never delayed.
 */
const TOOL_UPDATE_MIN_GROWTH_CHARS = 256
const TOOL_UPDATE_COALESCE_LIMIT = 10

/** The longest of the three things that grow while a tool call runs. */
export function toolCallProgressLength(state: AcpToolCallState): number {
  return Math.max(
    state.input?.length ?? 0,
    state.output?.length ?? 0,
    state.rawOutputChars ?? 0
  )
}

export function decideToolCallUpdateEmission(input: {
  previous: AcpToolCallState | undefined
  next: AcpToolCallState
  lastEmittedProgress: number | undefined
  skippedSinceEmit: number
}): { emit: boolean; skippedSinceEmit: number } {
  const { previous, next, lastEmittedProgress, skippedSinceEmit } = input
  if (next.status === "done" || next.status === "error") {
    return { emit: true, skippedSinceEmit: 0 }
  }
  if (
    previous === undefined ||
    previous.title !== next.title ||
    previous.status !== next.status
  ) {
    return { emit: true, skippedSinceEmit: 0 }
  }
  if (
    previous.input === next.input &&
    previous.output === next.output &&
    previous.rawOutputChars === next.rawOutputChars
  ) {
    return { emit: false, skippedSinceEmit }
  }
  const progress = toolCallProgressLength(next)
  const grew =
    lastEmittedProgress === undefined ||
    Math.abs(progress - lastEmittedProgress) >= TOOL_UPDATE_MIN_GROWTH_CHARS
  if (grew || skippedSinceEmit + 1 >= TOOL_UPDATE_COALESCE_LIMIT) {
    return { emit: true, skippedSinceEmit: 0 }
  }
  return { emit: false, skippedSinceEmit: skippedSinceEmit + 1 }
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
    return updated === undefined ? undefined : stringifyField(updated)
  }
  if (base && typeof base === "object" && !Array.isArray(base)) {
    return stringifyField({ ...derived, ...(base as Record<string, unknown>) })
  }
  return base === undefined || base === null
    ? stringifyField(derived)
    : stringifyField(base)
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
  // Left unbounded here: the read envelope below has to be unwrapped off the
  // head before `boundToolOutput` keeps only the tail. Nothing this size is
  // ever retained or emitted — `mapToolCall` bounds it a line later.
  return parts.length ? parts.join("\n") : undefined
}

/** Past this a `content` payload is a growing terminal, not a file read. */
const ENVELOPE_MAX_CHARS = 200_000

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

export function stringifyField(value: unknown): string | undefined {
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

/**
 * Some agents mark a replayed notification per message rather than only
 * bracketing the `session/load` that caused it — a resumed thread would
 * otherwise duplicate itself the moment one arrives outside that latch.
 *
 * Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
 */
export function sessionUpdateIsReplay(params: unknown): boolean {
  if (!params || typeof params !== "object") return false
  const meta = (params as { _meta?: unknown })._meta
  return (
    !!meta &&
    typeof meta === "object" &&
    (meta as { isReplay?: unknown }).isReplay === true
  )
}

/**
 * JSON-RPC's own "internal error". Spelled out rather than imported from
 * `lib/acp-types`, which this module deliberately takes no value from.
 */
const INTERNAL_ERROR = -32603

/**
 * What a request the agent is blocked on is answered with once the run is
 * stopped. A permission and a user-input question have a "cancelled" outcome
 * in the protocol; anything else — an `fs/*` call we were about to serve — is
 * refused, because performing it for a turn that no longer exists is worse
 * than failing it.
 */
export function cancellationReply(
  method: string
): { result: unknown } | { error: { code: number; message: string } } {
  if (
    method === "session/request_permission" ||
    method.endsWith("/request_user_input")
  ) {
    return { result: { outcome: { outcome: "cancelled" } } }
  }
  return {
    error: { code: INTERNAL_ERROR, message: "The turn was cancelled" },
  }
}
