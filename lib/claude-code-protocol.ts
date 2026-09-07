import type { AgentStreamEvent, AgentTokenUsage } from "@/lib/cursor-agent-types"
import { exitCodeFrom } from "@/lib/providers/exit-code"
import type { PermissionMode } from "@/lib/providers/types"
import {
  applyUsageLimitsUpdate,
  clampPercent,
  formatResetWait,
  makeUsageLimits,
  type ProviderUsageLimits,
  type ProviderUsageLimitsUpdate,
  type ProviderUsageWindow,
} from "@/lib/usage-limits"

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
 * that `result.is_error` moves while `subtype` stays `"success"`, that Bash
 * reports its exit status only as prose, and that a parked usage window ends
 * the turn by simply never sending a result.
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
  /**
   * Set on everything a subagent produced. The parent transcript is not that
   * conversation, so its narration is dropped and only its tool rows survive
   * — see `streamEvent` and `assistantMessage`.
   */
  parent_tool_use_id?: string | null
  duration_ms?: number
  is_error?: boolean
  result?: unknown
  /** Why the turn ended, when the CLI classified it. See `classifyResult`. */
  terminal_reason?: string
  /** The HTTP status behind a run of API failures; 529 is "overloaded". */
  api_error_status?: number
  errors?: unknown[]
  /** On an assistant line: `authentication_failed` and friends. */
  error?: string
  usage?: Record<string, unknown>
  /** Per-model totals on a result line — where the true context window is. */
  modelUsage?: Record<string, { contextWindow?: number }>
  /** `system:compact_boundary`: what the compaction cost and saved. */
  compact_metadata?: { pre_tokens?: number; post_tokens?: number }
  /** `rate_limit_event`, and the same shape the init line may carry. */
  rate_limit_info?: ClaudeRateLimitInfo
  rate_limits_available?: boolean
  rate_limits?: Record<string, unknown>
  message?: {
    id?: string
    model?: string
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

/** One streamed quota notice. `utilization` is a 0–1 fraction here. */
export type ClaudeRateLimitInfo = {
  status?: string
  rateLimitType?: string
  utilization?: number
  /** Epoch **seconds**, not milliseconds. */
  resetsAt?: number
  overageStatus?: string
  isUsingOverage?: boolean
  overageInUse?: boolean
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
 * The turn's counters. `AgentTokenUsage` upstream is input, output and a rate;
 * the cache and reasoning splits are optional there and declared here as well
 * so this file typechecks against either version of the vendored type while
 * the registry catches up. Assigned as this type — never as an object literal
 * annotated `AgentTokenUsage` — so the extra fields survive.
 */
export type ClaudeTokenUsage = AgentTokenUsage & {
  /** Input tokens served from the prompt cache, at a tenth of the price. */
  cachedInputTokens?: number
  /** Input tokens written *into* the cache, at a quarter more. */
  cacheCreationTokens?: number
  /** The share of `output` that was thinking. */
  reasoningTokens?: number
}

/* -------------------------------------------------------------------------- */
/* Session ids                                                                 */
/* -------------------------------------------------------------------------- */

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
/**
 * `SessionStart` hooks run before the resumed session exists, and the lines
 * they emit carry a session id of their own — a transient one that `--resume`
 * refuses on the next turn. On a resumed run those three subtypes arrive
 * *before* `system:init`, so taking the first id off the wire would replace a
 * chat's durable id with one that cannot be resumed.
 */
const TRANSIENT_SESSION_SUBTYPES = new Set([
  "hook_started",
  "hook_progress",
  "hook_response",
])

function hasDurableSessionId(event: ClaudeCodeCliEvent): boolean {
  if (event.type !== "system") return true
  return !TRANSIENT_SESSION_SUBTYPES.has(event.subtype ?? "")
}

/* -------------------------------------------------------------------------- */
/* Result classification                                                       */
/* -------------------------------------------------------------------------- */

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
/**
 * A structured reason the turn ended, as a sentence. `api_error` is the one
 * that leans on the hint: the CLI reports an expired login and a rejected
 * usage window both as a run of API errors, and only the earlier lines of the
 * turn say which it was.
 */
function terminalReasonMessage(
  reason: string | undefined,
  failureHint?: string
): string | undefined {
  switch (reason) {
    case "api_error":
      return failureHint ?? "Claude gave up after repeated API errors."
    case "malformed_tool_use_exhausted":
      return "Claude gave up after repeated malformed tool calls."
    case "budget_exhausted":
      return "Claude stopped: the turn's token budget was exhausted."
    case "structured_output_retry_exhausted":
      return "Claude could not produce the requested structured output."
    case "tool_deferred_unavailable":
      return "Claude could not resume a deferred tool call: the tool is no longer available."
    case "turn_setup_failed":
      return "Claude could not start the turn."
    case "blocking_limit":
      return "Claude stopped: a usage limit blocked the request."
    case "rapid_refill_breaker":
      return "Claude stopped: the context refilled too quickly after compaction."
    case "prompt_too_long":
      return "Claude stopped: the prompt exceeds the model's context window."
    case "image_error":
      return "Claude stopped: an image in the conversation could not be processed."
    case "model_error":
      return "Claude stopped: the model returned an error."
    default:
      return undefined
  }
}

function listedErrors(event: ClaudeCodeCliEvent): string[] {
  return Array.isArray(event.errors)
    ? event.errors.filter((entry): entry is string => typeof entry === "string")
    : []
}

/**
 * The user pressed stop. The CLI stamps it explicitly — mid-tool-call ends as
 * `aborted_tools` (with an internal `[ede_diagnostic] …` entry and `is_error`
 * true), mid-stream as `aborted_streaming` — and a cancellation also arrives
 * as `error_during_execution` with `is_error` false. None of them is a
 * failure, and none may leave an error row behind: the user knows.
 */
function isAbortedResult(event: ClaudeCodeCliEvent): boolean {
  if (
    event.terminal_reason === "aborted_tools" ||
    event.terminal_reason === "aborted_streaming"
  ) {
    return true
  }
  // A cancellation the CLI could not stamp: the run ended mid-execution and
  // nothing failed, which only happens because something stopped it.
  if (event.subtype === "error_during_execution" && event.is_error === false) {
    return true
  }
  const errors = listedErrors(event).join(" ").toLowerCase()
  return (
    errors.includes("interrupt") ||
    errors.includes("request was aborted") ||
    errors.includes("cancelled by user")
  )
}

export type ClaudeResultOutcome = {
  /** `aborted` is a turn the user stopped: it ends, and says nothing. */
  status: "completed" | "failed" | "aborted"
  message?: string
}

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
/**
 * The CLI's verdict on the turn, read from every field that carries one.
 *
 * `subtype` is not that field — it stays `"success"` through a failed run —
 * and neither is `is_error` alone: a repeated 529 comes back as a *success*
 * with `api_error_status` set, and a stop the user asked for comes back as a
 * failure. What is trustworthy is `terminal_reason`, then the listed errors,
 * with `is_error` and the result text as the last resort.
 */
export function classifyResult(
  event: ClaudeCodeCliEvent,
  failureHint?: string
): ClaudeResultOutcome {
  if (isAbortedResult(event)) return { status: "aborted" }

  const successTaggedFailure =
    event.subtype === "success" && event.is_error === true
  // Repeated overload comes back tagged success with the status code as the
  // only structured signal there is.
  const structured =
    event.subtype === "success" && event.api_error_status === 529
      ? "Claude API is overloaded (529). Try again shortly."
      : (terminalReasonMessage(event.terminal_reason, failureHint) ??
        (successTaggedFailure ? failureHint : undefined))
  // The CLI's own diagnostics are not an error banner: `[ede_diagnostic] …`
  // entries ride along with ordinary aborts and mean nothing to the user.
  const listed =
    event.subtype === "success" && !successTaggedFailure
      ? undefined
      : listedErrors(event).find(
          (entry) => !entry.startsWith("[ede_diagnostic]")
        )
  const message = listed || structured
  if (message) return { status: "failed", message }
  // Nothing classified it, but the CLI still says it failed — an unknown
  // model comes back this way, as a sentence in `result`.
  if (event.is_error) {
    return {
      status: "failed",
      message: stringify(event.result) || "Claude Code failed",
    }
  }
  if (event.subtype === "success") return { status: "completed" }
  return { status: "failed", message: "Claude Code failed" }
}

/* -------------------------------------------------------------------------- */
/* Usage limits                                                                */
/* -------------------------------------------------------------------------- */

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
/**
 * The account-wide windows, keyed by the CLI's own `rateLimitType`. Both
 * sources produce the same ids, so a notice streamed during a turn lands on
 * the row a full read already drew.
 */
const CLAUDE_WINDOWS: Record<
  string,
  Pick<ProviderUsageWindow, "kind" | "label" | "windowDurationMins">
> = {
  five_hour: { kind: "session", label: "5-hour", windowDurationMins: 5 * 60 },
  seven_day: { kind: "weekly", label: "7-day", windowDurationMins: 7 * 24 * 60 },
  seven_day_opus: {
    kind: "weekly",
    label: "7-day Opus",
    windowDurationMins: 7 * 24 * 60,
  },
  seven_day_sonnet: {
    kind: "weekly",
    label: "7-day Sonnet",
    windowDurationMins: 7 * 24 * 60,
  },
  seven_day_overage_included: {
    kind: "weekly",
    label: "7-day model",
    windowDurationMins: 7 * 24 * 60,
  },
  overage: { kind: "other", label: "overage" },
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined
  }
  return new Date(value * 1000).toISOString()
}

function isoFromString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

function claudeWindow(
  id: string,
  usedPercent: number,
  resetsAt: string | undefined
): ProviderUsageWindow {
  const shape = CLAUDE_WINDOWS[id] ?? { kind: "other" as const, label: id }
  return {
    id,
    ...shape,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : null),
  }
}

/**
 * One streamed notice as an update. `utilization` is a 0–1 fraction here and
 * a 0–100 percentage on the full read, which is the whole reason the two are
 * mapped separately rather than shoved through one function.
 */
export function rateLimitEventToUpdate(
  info: ClaudeRateLimitInfo | undefined
): ProviderUsageLimitsUpdate | undefined {
  if (!info?.rateLimitType || typeof info.utilization !== "number") {
    return undefined
  }
  return {
    windows: [
      claudeWindow(
        info.rateLimitType,
        info.utilization * 100,
        isoFromEpochSeconds(info.resetsAt)
      ),
    ],
  }
}

/**
 * The `get_usage`-shaped read: percentages already 0–100, ISO reset times,
 * and the model-scoped weeklies the CLI lists separately. The probe reads it
 * off the init line, where a recent CLI carries it.
 */
export function usageResponseToLimits(
  response: {
    rate_limits_available?: boolean
    rate_limits?: Record<string, unknown>
  },
  checkedAt: string
): ProviderUsageLimits | undefined {
  if (response.rate_limits_available === false) return undefined
  const limits = response.rate_limits
  if (!limits || typeof limits !== "object") return undefined
  const windows: ProviderUsageWindow[] = []
  for (const [id, value] of Object.entries(limits)) {
    if (id === "model_scoped" || !value || typeof value !== "object") continue
    const window = value as { utilization?: unknown; resets_at?: unknown }
    if (typeof window.utilization !== "number") continue
    windows.push(claudeWindow(id, window.utilization, isoFromString(window.resets_at)))
  }
  const scoped = (limits as { model_scoped?: unknown }).model_scoped
  if (Array.isArray(scoped)) {
    for (const entry of scoped) {
      if (!entry || typeof entry !== "object") continue
      const window = entry as {
        display_name?: unknown
        utilization?: unknown
        resets_at?: unknown
      }
      if (
        typeof window.display_name !== "string" ||
        typeof window.utilization !== "number"
      ) {
        continue
      }
      windows.push({
        id: `seven_day_${window.display_name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        kind: "weekly",
        label: `7-day ${window.display_name}`,
        windowDurationMins: 7 * 24 * 60,
        usedPercent: clampPercent(window.utilization),
        ...(isoFromString(window.resets_at)
          ? { resetsAt: isoFromString(window.resets_at) }
          : null),
      })
    }
  }
  return windows.length ? makeUsageLimits({ checkedAt, windows }) : undefined
}

/**
 * A window that answers `rejected` parks the turn *inside* the CLI: no
 * further lines arrive and no result ever lands, so a run that says nothing
 * about it simply spins until the user gives up. Overage is the exception —
 * an account allowed to spend it, or already spending it, keeps running.
 */
function isBlockedByLimit(info: ClaudeRateLimitInfo): boolean {
  const overageAllowed =
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true ||
    info.overageInUse === true
  return info.status === "rejected" && !overageAllowed
}

/** Beyond this a reset time is not credible, so the line ships without one. */
const MAX_CREDIBLE_WAIT_MS = 30 * 24 * 60 * 60 * 1000

function describeUsageLimit(info: ClaudeRateLimitInfo, nowMs: number): string {
  const label = info.rateLimitType
    ? (CLAUDE_WINDOWS[info.rateLimitType]?.label ?? info.rateLimitType)
    : undefined
  const resetsAtMs =
    info.resetsAt === undefined ? undefined : info.resetsAt * 1000
  const waitMs = resetsAtMs === undefined ? undefined : resetsAtMs - nowMs
  const wait =
    waitMs !== undefined && waitMs > 0 && waitMs <= MAX_CREDIBLE_WAIT_MS
      ? formatResetWait(waitMs)
      : undefined
  return `Rate limited on the ${label ?? "usage"} window${
    wait ? `, resets in ${wait}` : ""
  }`
}

/* -------------------------------------------------------------------------- */
/* The translator                                                              */
/* -------------------------------------------------------------------------- */

/** What a tool row says when the turn ended before the tool did. */
const INTERRUPTED = "Interrupted"

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
 *
 * Stateful for a second reason too: a turn does not always end with a result.
 * The rows a tool opened, the hint an earlier line left behind and the window
 * that parked the run all live here, so `finish` can close the turn honestly
 * whichever way it ended.
 */
export class ClaudeCodeTranslator {
  private sessionEmitted = false
  private currentMessageId: string | undefined
  private readonly streamedIds = new Set<string>()
  /** tool_use id → name, so a tool_result can name the row it completes. */
  private readonly toolNames = new Map<string, string>()
  /** Rows that started and have not been completed by a tool_result yet. */
  private readonly openTools = new Set<string>()
  private gotText = false
  private finished = false
  /**
   * Evidence an earlier line left for the result to use: the CLI reports an
   * expired login and a rejected usage window alike as "repeated API errors".
   */
  private failureHint: string | undefined
  private readonly rejectedWindows = new Set<string>()
  /** window:resetsAt pairs already announced, so a repeat stays quiet. */
  private readonly announcedLimits = new Set<string>()

  /** True once a `result` line arrived — the CLI's own verdict on the turn. */
  sawResult = false

  /**
   * Set when the turn can no longer make progress but the CLI will not say so
   * — today, a parked usage window. The subprocess is holding a turn that
   * will never produce a result, so the caller stops reading and kills it.
   */
  stopRequested = false

  /** The model the assistant lines said they ran on, subagents excluded. */
  model: string | undefined

  /** The real context window, off `result.modelUsage`, when one was reported. */
  contextWindow: number | undefined

  /** The quota windows this turn heard about, folded in arrival order. */
  usageLimits: ProviderUsageLimits | undefined

  /**
   * The clock, injectable so a test can pin the remaining wait on a parked
   * usage window. Not a parameter property: Node's strip-only TypeScript
   * refuses to parse one, and this file has to load under `node --test`.
   */
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  translate(event: ClaudeCodeCliEvent): AgentStreamEvent[] {
    const out: AgentStreamEvent[] = []
    if (this.finished) return out

    if (
      !this.sessionEmitted &&
      typeof event.session_id === "string" &&
      hasDurableSessionId(event)
    ) {
      this.sessionEmitted = true
      out.push({ type: "session", sessionId: event.session_id })
    }

    if (event.type === "system") {
      this.systemLine(event, out)
      return out
    }
    if (event.type === "rate_limit_event") {
      this.rateLimit(event, out)
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

  /**
   * Closes a turn that ended without a result — an abort, a spawn failure, a
   * non-zero exit, a stream that simply stopped. Every row still marked
   * running would otherwise spin forever in the transcript; nothing else in
   * the turn is left half-open, since text and thinking are streamed rather
   * than accumulated. Idempotent, and translating after it is a no-op.
   */
  finish(ok: boolean): AgentStreamEvent[] {
    if (this.finished) return []
    this.finished = true
    const out: AgentStreamEvent[] = []
    // "Done" is only honest when the CLI itself said the turn succeeded.
    this.closeOpenTools(out, ok && this.sawResult)
    this.currentMessageId = undefined
    return out
  }

  private systemLine(event: ClaudeCodeCliEvent, out: AgentStreamEvent[]) {
    // Startup is the slow part — settings, hooks, plugins and the project's
    // CLAUDE.md all load before the first token — and until this line lands
    // the composer has nothing to show.
    if (event.subtype === "init") {
      const limits = usageResponseToLimits(
        event,
        new Date(this.now()).toISOString()
      )
      if (limits) this.usageLimits = limits
      out.push({
        type: "status",
        stage: "connecting",
        text: "Claude Code session ready",
      })
      return
    }
    // Compaction is invisible otherwise: the turn keeps going, the numbers
    // under it drop by an order of magnitude, and nothing says why.
    if (event.subtype === "compact_boundary") {
      const pre = numberAt(event.compact_metadata ?? {}, "pre_tokens")
      const post = numberAt(event.compact_metadata ?? {}, "post_tokens")
      if (post == null) return
      out.push({
        type: "status",
        text:
          pre == null
            ? `Context compacted to ${compactTokens(post)} tokens`
            : `Context compacted: ${compactTokens(pre)} → ${compactTokens(post)} tokens`,
      })
    }
  }

  private rateLimit(event: ClaudeCodeCliEvent, out: AgentStreamEvent[]) {
    const info = event.rate_limit_info
    if (!info) return
    const update = rateLimitEventToUpdate(info)
    if (update) {
      this.usageLimits = applyUsageLimitsUpdate({
        previous: this.usageLimits,
        update,
        checkedAt: new Date(this.now()).toISOString(),
      })
    }

    const window = info.rateLimitType ?? "unknown"
    const blocked = isBlockedByLimit(info)
    // Whether a window blocks right now is independent of whether its notice
    // has already been shown: a recovery can arrive with a later reset time,
    // and it must not clear a different window that is still parked.
    if (blocked) this.rejectedWindows.add(window)
    else if (info.status === "allowed" || info.status === "allowed_warning") {
      this.rejectedWindows.delete(window)
    }
    if (!blocked) return

    // Keyed by window and reset instant, not by the rendered line: a parked
    // window re-fires while the remaining wait shrinks, and a turn can park
    // on more than one window at once.
    const key = `${window}:${info.resetsAt ?? "unknown"}`
    if (this.announcedLimits.has(key)) return
    this.announcedLimits.add(key)

    const notice = describeUsageLimit(info, this.now())
    out.push({ type: "status", text: notice })
    // And then end it. The CLI holds the turn open with nothing left to send,
    // so without this the chat streams an empty answer until the user gives up.
    out.push({
      type: "error",
      message: `Claude usage limit reached. ${notice}. Send the message again once the window resets.`,
    })
    this.stopRequested = true
  }

  private streamEvent(event: ClaudeCodeCliEvent, out: AgentStreamEvent[]) {
    const inner = event.event
    if (!inner) return
    const subagent = event.parent_tool_use_id != null

    if (inner.type === "message_start") {
      // A subagent's message id must not become the parent's: `markStreamed`
      // would then file the parent's own deltas under it, and the parent's
      // whole message would print its text a second time.
      if (!subagent) this.currentMessageId = inner.message?.id
      return
    }

    // A tool call announces itself with id and name before its arguments have
    // finished streaming — enough to show the row as running straight away.
    // This is the one part of a subagent's stream that is kept: the rows it
    // opens are work the user is watching, unlike its narration.
    if (inner.type === "content_block_start") {
      const block = inner.content_block
      if (block?.type === "tool_use" && block.id) {
        this.toolNames.set(block.id, block.name || "tool")
        this.openTools.add(block.id)
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
    // Everything a subagent narrates belongs to its own conversation. Emitting
    // it interleaves several agents' half-sentences into the one answer.
    if (subagent) return
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
    const subagent = event.parent_tool_use_id != null
    const model = typeof message?.model === "string" ? message.model.trim() : ""
    if (model && !subagent) this.model = model

    // The CLI can report an expired login before ending the turn as a generic
    // API error, so the evidence is kept for the result to use. A *subagent's*
    // failure is not the parent's, and must not poison the parent's verdict.
    if (!subagent && event.error === "authentication_failed") {
      this.failureHint =
        "Claude could not authenticate. Run `claude auth login` on this machine, then start a new chat."
    }

    // A subagent's snapshot is its own conversation, not the parent's: its
    // text and thinking are dropped whole (they were dropped while streaming
    // too, so nothing here can duplicate what the user already read) and only
    // the tool rows it opened survive, deduped by id like every other row.
    const alreadyStreamed =
      subagent || Boolean(message?.id && this.streamedIds.has(message.id))

    for (const block of message?.content ?? []) {
      if (block.type === "tool_use" && block.id) {
        this.toolNames.set(block.id, block.name || "tool")
        this.openTools.add(block.id)
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
      this.openTools.delete(block.tool_use_id)
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

  /** Every row still running gets its terminal event, once. */
  private closeOpenTools(out: AgentStreamEvent[], ok: boolean) {
    for (const id of this.openTools) {
      out.push({
        type: "tool",
        id,
        name: this.toolNames.get(id) ?? "tool",
        status: ok ? "done" : "error",
        ...(ok ? null : { output: INTERRUPTED }),
      })
    }
    this.openTools.clear()
  }

  private result(event: ClaudeCodeCliEvent, out: AgentStreamEvent[]) {
    this.sawResult = true

    // A window that rejected this turn is the other thing the CLI reports as
    // an unexplained run of API errors.
    const hint =
      this.failureHint ??
      (this.rejectedWindows.size > 0
        ? "Claude usage limit reached. Send the message again once the limit resets."
        : undefined)
    const outcome = classifyResult(event, hint)

    // The rows first: a tool the turn abandoned belongs to the turn, not to
    // whatever comes after it.
    this.closeOpenTools(out, outcome.status === "completed")

    if (outcome.status === "failed") {
      out.push({ type: "error", message: outcome.message || "Claude Code failed" })
    } else if (
      !this.gotText &&
      typeof event.result === "string" &&
      event.result
    ) {
      // No partial messages and no assistant blocks: the answer is only here.
      out.push({ type: "text", text: event.result })
    }

    const window = maxContextWindow(event.modelUsage)
    if (window) this.contextWindow = window

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
 * The turn's token counts.
 *
 * `input` stays the *uncached* input tokens: `AgentTokenUsage`'s two numbers
 * are what the UI puts under the answer, and folding a 33k cache read into
 * "input" would put a number there that bears no relation to what the next
 * turn's context has to fit. The cache halves are carried beside it instead,
 * where pricing can charge them at their own rates (a tenth for a read, a
 * quarter more for a write) and the meter can leave them out.
 *
 * A turn that looped reports every pass in `iterations[]`; the last entry is
 * the state the turn actually ended in, and the earlier ones are already
 * folded into it.
 */
function readUsage(event: ClaudeCodeCliEvent): ClaudeTokenUsage | undefined {
  const outer = event.usage
  if (!outer) return undefined
  const raw = lastIteration(outer) ?? outer
  const input = numberAt(raw, "input_tokens")
  const output = numberAt(raw, "output_tokens")
  const cached = numberAt(raw, "cache_read_input_tokens")
  const created = numberAt(raw, "cache_creation_input_tokens")
  const details = raw.output_tokens_details
  const thinking =
    details && typeof details === "object"
      ? numberAt(details as Record<string, unknown>, "thinking_tokens")
      : null
  if (input == null && output == null && cached == null && created == null) {
    return undefined
  }
  const usage: ClaudeTokenUsage = {
    ...(input == null ? null : { input }),
    ...(output == null ? null : { output }),
    ...(cached == null ? null : { cachedInputTokens: cached }),
    ...(created == null ? null : { cacheCreationTokens: created }),
    // Reasoning is a share of the output, never more than it — a CLI that
    // reports the two out of step must not produce a negative remainder.
    ...(thinking == null || output == null
      ? null
      : { reasoningTokens: Math.min(output, thinking) }),
  }
  return usage
}

/** The last object in `usage.iterations`, when the CLI reported any. */
function lastIteration(
  usage: Record<string, unknown>
): Record<string, unknown> | undefined {
  const iterations = usage.iterations
  if (!Array.isArray(iterations)) return undefined
  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    const entry = iterations[index]
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return entry as Record<string, unknown>
    }
  }
  return undefined
}

/**
 * The turn's real context window. `modelUsage` is keyed by model and a turn
 * can touch more than one (a small model summarising for a big one), so the
 * largest is the one the conversation is actually held against.
 */
function maxContextWindow(
  modelUsage: ClaudeCodeCliEvent["modelUsage"]
): number | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined
  let best: number | undefined
  for (const entry of Object.values(modelUsage)) {
    const window = entry?.contextWindow
    if (typeof window === "number" && Number.isFinite(window) && window > 0) {
      best = Math.max(best ?? 0, window)
    }
  }
  return best
}

function numberAt(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** `180k`, `1.2M` — only ever for the compaction line. */
function compactTokens(value: number): string {
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
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
