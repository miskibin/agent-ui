import type { AgentStreamEvent, AgentTokenUsage } from "@/lib/cursor-agent-types"
import { exitCodeFrom } from "@/lib/providers/exit-code"
import type { PermissionMode } from "@/lib/providers/types"

/**
 * What the Claude Code CLI says, and what we say to it: the `-p
 * --output-format stream-json` protocol translation plus the argv that asks
 * for it. `lib/claude-code-agent.ts` owns the subprocess around this.
 *
 * The split is not cosmetic — it is what lets the whole protocol be tested.
 * Everything here is pure and imports nothing the test runner cannot load, so
 * `tests/claude-code-stream.test.ts` drives it with recorded lines instead of
 * spawning a CLI; the spawn half reaches `lib/stream-framing`, whose parameter
 * property Node's strip-only TypeScript mode refuses to parse.
 *
 * Every shape read below was captured from a real run of CLI 2.1.258, not
 * taken from the docs alone — including the parts the docs do not spell out:
 * that `result.is_error` moves while `subtype` stays `"success"`, and that
 * Bash reports its exit status only as prose.
 */

const MAX_FIELD = 50_000

/** The CLI's own `--effort` ladder; the app's four ids are a subset of it. */
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"])

/**
 * Tool names that write. A deny rule outranks every allow rule and every
 * `permissions.allow` entry in the user's own settings, and the CLI tells the
 * model a denied tool is "disabled for this session, in subagents as well as
 * here" — which is what makes `read-only` a real block rather than a request
 * the model might talk its way past.
 */
const WRITE_TOOLS = "Edit,Write,NotebookEdit,Bash,BashOutput,KillShell"

/** Everything `acceptEdits` alone still holds back — shell and the network. */
const FULL_ACCESS_TOOLS = "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch"

/**
 * The app's per-chat mode → the CLI's permission flags for this turn.
 *
 * `-p` starts in the CLI's Manual mode, where an unapproved call simply fails:
 * there is no terminal, so nobody can answer a prompt and every mode has to
 * name its baseline explicitly.
 *
 * - `read-only` — `dontAsk` denies anything outside the CLI's read-only
 *   command set, and the deny list removes the writing tools outright.
 * - `edits` — `acceptEdits` writes files without prompting; other shell
 *   commands and network calls stay unapproved, which is exactly the gap
 *   between this mode and the next.
 * - `full` — `acceptEdits` plus an allow list covering shell and the network.
 *   Deliberately *not* `bypassPermissions`: that also skips the CLI's own
 *   guardrails, and it refuses to start at all under root — which anything
 *   packaged into a container would hit as a plain startup failure.
 */
export function permissionArgs(mode: PermissionMode): string[] {
  if (mode === "read-only") {
    return ["--permission-mode", "dontAsk", "--disallowedTools", WRITE_TOOLS]
  }
  if (mode === "full") {
    return [
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      FULL_ACCESS_TOOLS,
    ]
  }
  return ["--permission-mode", "acceptEdits"]
}

/**
 * Argv for one turn — note what is *not* in it: the prompt.
 *
 * It goes on stdin, which keeps a long paste clear of the platform's argv
 * limit and, just as importantly, out of reach of the CLI's variadic flags.
 * `claude -p --allowedTools "Bash,Read" "<prompt>"` swallows the prompt as
 * another tool name and the run dies with "Input must be provided either
 * through stdin or as a prompt argument".
 */
export function buildArgs(options: {
  model?: string
  effort?: string
  sessionId?: string
  permissionMode: PermissionMode
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    // stream-json refuses to run without --verbose; partial messages are what
    // turn a per-message protocol into token-by-token streaming.
    "--verbose",
    "--include-partial-messages",
  ]
  if (options.model) args.push("--model", options.model)
  if (options.effort && EFFORT_LEVELS.has(options.effort)) {
    args.push("--effort", options.effort)
  }
  if (options.sessionId) args.push("--resume", options.sessionId)
  args.push(...permissionArgs(options.permissionMode))
  return args
}

/** Only the fields we read; the CLI emits many more and they are ignored. */
export type ClaudeCodeCliEvent = {
  type?: string
  subtype?: string
  session_id?: string
  parent_tool_use_id?: string | null
  duration_ms?: number
  is_error?: boolean
  result?: unknown
  usage?: Record<string, unknown>
  message?: {
    id?: string
    content?: ClaudeCodeBlock[]
  }
  event?: {
    type?: string
    message?: { id?: string }
    content_block?: ClaudeCodeBlock
    delta?: { type?: string; text?: string; thinking?: string }
  }
  tool_use_result?: unknown
}

type ClaudeCodeBlock = {
  type?: string
  text?: string
  thinking?: string
  /** tool_use */
  id?: string
  name?: string
  input?: unknown
  /** tool_result */
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

/**
 * Folds the CLI's line protocol into app events.
 *
 * Stateful because two of the CLI's shapes overlap: with
 * `--include-partial-messages` every assistant message arrives twice — first
 * as `stream_event` deltas, then again whole. Text and thinking are taken from
 * the deltas (that *is* the streaming), and the complete message is used only
 * for its `tool_use` blocks, whose streamed `input_json_delta` fragments are
 * unusable partial JSON. `streamedIds` is what stops the two double-printing,
 * while still letting a whole message speak when partials are off.
 */
export class ClaudeCodeTranslator {
  private sessionEmitted = false
  private currentMessageId: string | undefined
  private readonly streamedIds = new Set<string>()
  /** tool_use id → name, so a tool_result can name the row it completes. */
  private readonly toolNames = new Map<string, string>()
  private gotText = false

  /** True once a `result` line arrived — the CLI's own verdict on the turn. */
  sawResult = false

  translate(event: ClaudeCodeCliEvent): AgentStreamEvent[] {
    const out: AgentStreamEvent[] = []

    if (!this.sessionEmitted && typeof event.session_id === "string") {
      this.sessionEmitted = true
      out.push({ type: "session", sessionId: event.session_id })
    }

    // Startup is the slow part — settings, hooks, plugins and the project's
    // CLAUDE.md all load before the first token — and until this line lands
    // the composer has nothing to show.
    if (event.type === "system" && event.subtype === "init") {
      out.push({
        type: "status",
        stage: "connecting",
        text: "Claude Code session ready",
      })
      return out
    }

    if (event.type === "stream_event") {
      this.streamEvent(event, out)
      return out
    }
    if (event.type === "assistant") {
      this.assistantMessage(event, out)
      return out
    }
    if (event.type === "user") {
      this.toolResults(event, out)
      return out
    }
    if (event.type === "result") {
      this.result(event, out)
    }
    return out
  }

  private streamEvent(event: ClaudeCodeCliEvent, out: AgentStreamEvent[]) {
    const inner = event.event
    if (!inner) return

    if (inner.type === "message_start") {
      this.currentMessageId = inner.message?.id
      return
    }

    // A tool call announces itself with id and name before its arguments have
    // finished streaming — enough to show the row as running straight away.
    if (inner.type === "content_block_start") {
      const block = inner.content_block
      if (block?.type === "tool_use" && block.id) {
        this.toolNames.set(block.id, block.name || "tool")
        out.push({
          type: "tool",
          id: block.id,
          name: block.name || "tool",
          status: "running",
        })
      }
      return
    }

    if (inner.type !== "content_block_delta") return
    const delta = inner.delta
    if (delta?.type === "text_delta" && delta.text) {
      this.markStreamed()
      this.gotText = true
      out.push({ type: "text", text: delta.text })
      return
    }
    if (delta?.type === "thinking_delta" && delta.thinking) {
      this.markStreamed()
      out.push({ type: "thinking", text: delta.thinking })
    }
  }

  private markStreamed() {
    if (this.currentMessageId) this.streamedIds.add(this.currentMessageId)
  }

  private assistantMessage(event: ClaudeCodeCliEvent, out: AgentStreamEvent[]) {
    const message = event.message
    const alreadyStreamed = Boolean(
      message?.id && this.streamedIds.has(message.id)
    )

    for (const block of message?.content ?? []) {
      if (block.type === "tool_use" && block.id) {
        this.toolNames.set(block.id, block.name || "tool")
        out.push({
          type: "tool",
          id: block.id,
          name: block.name || "tool",
          status: "running",
          input: stringify(block.input),
        })
        continue
      }
      if (alreadyStreamed) continue
      if (block.type === "text" && block.text) {
        this.gotText = true
        out.push({ type: "text", text: block.text })
        continue
      }
      if (block.type === "thinking" && block.thinking) {
        out.push({ type: "thinking", text: block.thinking })
      }
    }
  }

  private toolResults(event: ClaudeCodeCliEvent, out: AgentStreamEvent[]) {
    const blocks = (event.message?.content ?? []).filter(
      (block): block is ClaudeCodeBlock & { tool_use_id: string } =>
        block.type === "tool_result" && Boolean(block.tool_use_id)
    )
    // `tool_use_result` hangs off the *message*, not the block, so it can only
    // be attributed when the message carries a single result. Parallel tool
    // calls come back batched, and handing every one of them the same exit code
    // and the same stdout would be an invention.
    const result = blocks.length === 1 ? event.tool_use_result : undefined
    // Bash publishes stdout and stderr but no structured exit code, so this is
    // usually absent — and absent is what it stays. `exitCodeFrom` reads a
    // field a backend actually published and never infers one from prose.
    const exitCode = exitCodeFrom(result)
    for (const block of blocks) {
      out.push({
        type: "tool",
        id: block.tool_use_id,
        name: this.toolNames.get(block.tool_use_id) ?? "tool",
        // The field is absent, not false, on a plain success.
        status: block.is_error === true ? "error" : "done",
        output: formatToolResult(block.content, result),
        ...(exitCode === undefined ? null : { exitCode }),
      })
    }
  }

  private result(event: ClaudeCodeCliEvent, out: AgentStreamEvent[]) {
    this.sawResult = true

    // `subtype` stays "success" on a failed run — `is_error` is the flag that
    // actually moves. An unknown model comes back this way (a 404 the CLI
    // turns into a sentence) rather than on stderr.
    if (event.is_error) {
      out.push({
        type: "error",
        message: stringify(event.result) || "Claude Code failed",
      })
    } else if (
      !this.gotText &&
      typeof event.result === "string" &&
      event.result
    ) {
      // No partial messages and no assistant blocks: the answer is only here.
      out.push({ type: "text", text: event.result })
    }

    const usage = readUsage(event)
    out.push({
      type: "done",
      sessionId:
        typeof event.session_id === "string" ? event.session_id : undefined,
      durationMs:
        typeof event.duration_ms === "number" ? event.duration_ms : undefined,
      ...(usage ? { usage } : null),
    })
  }
}

/** Parses one NDJSON line; non-JSON chatter on stdout is skipped. */
export function parseCliLine(line: string): ClaudeCodeCliEvent | null {
  const trimmed = line.replace(/\r$/, "").trim()
  if (!trimmed.startsWith("{")) return null
  try {
    return JSON.parse(trimmed) as ClaudeCodeCliEvent
  } catch {
    return null
  }
}

/**
 * The turn's token counts. Cache reads and writes are left out on purpose:
 * `AgentTokenUsage` is input and output, and folding a 33k cache read into
 * "input" would put a number under the answer that bears no relation to what
 * the next turn's context has to fit.
 */
function readUsage(event: ClaudeCodeCliEvent): AgentTokenUsage | undefined {
  const raw = event.usage
  if (!raw) return undefined
  const input = numberAt(raw, "input_tokens")
  const output = numberAt(raw, "output_tokens")
  if (input == null && output == null) return undefined
  return {
    ...(input == null ? null : { input }),
    ...(output == null ? null : { output }),
  }
}

function numberAt(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "number" ? value : null
}

/**
 * `tool_use_result` is preferred where it splits stdout from stderr; otherwise
 * the model-facing `content` is what gets shown. Bash puts its exit status in
 * that text ("Exit code 1\n…") and nothing here promotes prose to a real code.
 */
function formatToolResult(
  content: unknown,
  toolUseResult: unknown
): string | undefined {
  if (toolUseResult && typeof toolUseResult === "object") {
    const record = toolUseResult as Record<string, unknown>
    const stdout = typeof record.stdout === "string" ? record.stdout : ""
    const stderr = typeof record.stderr === "string" ? record.stderr : ""
    if (stdout || stderr) {
      return truncate([stdout, stderr].filter(Boolean).join("\n"))
    }
  }
  if (typeof content === "string") return content ? truncate(content) : undefined
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        block &&
        typeof block === "object" &&
        typeof (block as ClaudeCodeBlock).text === "string"
          ? ((block as ClaudeCodeBlock).text as string)
          : ""
      )
      .filter(Boolean)
      .join("\n")
    return text ? truncate(text) : undefined
  }
  return stringify(content)
}

function stringify(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === "string") return value ? truncate(value) : undefined
  try {
    return truncate(JSON.stringify(value, null, 2))
  } catch {
    return undefined
  }
}

function truncate(value: string) {
  return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…` : value
}
