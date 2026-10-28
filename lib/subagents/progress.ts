import type {
  AgentStreamEvent,
  AgentTokenUsage,
} from "@/lib/cursor-agent-types"
import { clip, isShellTool, looksLikeTestCommand } from "@/lib/handoff/journal"
import { collectToolPaths, extractToolCommand } from "@/lib/tool-paths"
import { isOpenUserRequestTool, parseUserRequestInput } from "@/lib/turn-requests"

/**
 * What an orchestrator is told about a subagent while it works — and after.
 *
 * The run's stream is folded, event by event, into a few counters and a short
 * step log, so `get_subagent` can answer "what is it doing, is it stuck, what
 * has it touched" in a few hundred characters instead of handing an agent the
 * transcript. That is the whole design constraint: every token this returns is
 * a token of the *orchestrator's* context, spent on every poll. So nothing
 * here is prose, nothing is unbounded, and the full log is only ever sent past
 * a cursor the caller already holds (`since_step`).
 *
 * Pure and free of `node:` — `lib/subagents/runs.ts` feeds it, the tests drive
 * it directly.
 */

/** Steps kept per run; older ones are dropped, their numbers are not reused. */
export const MAX_STEPS = 200
/** Paths named in a digest before the rest become a count. */
export const MAX_DIGEST_PATHS = 12
/** Log lines a `full` digest returns when no cursor narrows it. */
export const DEFAULT_LOG_LINES = 25
/** Characters of the subagent's latest text a `full` digest carries. */
export const OUTPUT_TAIL_CHARS = 1200

const MAX_LINE = 140

export type RunPhase =
  | "queued"
  | "starting"
  | "thinking"
  | "tool"
  | "writing"
  | "waiting_on_user"
  | "finished"

export type ProgressStep = {
  /** 1-based and monotonic: the cursor `since_step` is compared against. */
  n: number
  /** Seconds since the run started. */
  t: number
  line: string
  ok: boolean
}

export type RunProgress = {
  startedAt: number
  lastEventAt: number
  phase: RunPhase
  steps: ProgressStep[]
  stepCount: number
  /** The tool call in flight, as one line. */
  current?: string
  /** Edited paths → how many calls touched each. Insertion order is first-touch order. */
  edited: Map<string, number>
  readCount: number
  commands: number
  failedCommands: number
  tests: { passed: number; failed: number }
  toolErrors: number
  lastError?: string
  waiting?: { id: string; kind: string; title: string }
  usage?: AgentTokenUsage
  /** Tool inputs by id — the closing event of a call often carries none. */
  inputs: Map<string, { name: string; input?: string }>
}

export function createProgress(now: number, phase: RunPhase = "starting"): RunProgress {
  return {
    startedAt: now,
    lastEventAt: now,
    phase,
    steps: [],
    stepCount: 0,
    edited: new Map(),
    readCount: 0,
    commands: 0,
    failedCommands: 0,
    tests: { passed: 0, failed: 0 },
    toolErrors: 0,
    inputs: new Map(),
  }
}

/** Same vocabulary the vendored tool rows use (`isFileMutationTool`). */
export function isEditTool(name: string) {
  const kind = name.replace(/\s+/g, "").toLowerCase()
  return (
    kind.includes("write") ||
    kind.includes("createfile") ||
    kind.includes("edit") ||
    kind.includes("applypatch") ||
    kind.includes("searchreplace") ||
    kind.includes("strreplace")
  )
}

function isReadTool(name: string) {
  const kind = name.replace(/\s+/g, "").toLowerCase()
  return kind.includes("read") && !kind.includes("thread")
}

function parseArgs(input: string | undefined): Record<string, unknown> {
  if (!input) return {}
  try {
    const value = JSON.parse(input) as unknown
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** "Edit lib/a.ts", "Bash: npm test", "Grep" — what a call was, in one line. */
export function describeTool(name: string, input?: string) {
  const args = parseArgs(input)
  const label = name.trim() || "tool"
  const command = isShellTool(label) ? extractToolCommand(args) : undefined
  if (command) return clip(`${label}: ${command}`, MAX_LINE)
  const paths = collectToolPaths(args, { maxPaths: 2 })
  if (paths.length) {
    return clip(`${label} ${paths.join(", ")}`, MAX_LINE)
  }
  return label
}

function pushStep(progress: RunProgress, now: number, line: string, ok: boolean) {
  progress.stepCount += 1
  progress.steps.push({
    n: progress.stepCount,
    t: Math.max(0, Math.round((now - progress.startedAt) / 1000)),
    line,
    ok,
  })
  if (progress.steps.length > MAX_STEPS) progress.steps.shift()
}

/** Folds one stream event in. Mutates, because a run can stream thousands. */
export function trackEvent(progress: RunProgress, event: AgentStreamEvent, now: number) {
  progress.lastEventAt = now
  switch (event.type) {
    case "thinking":
      if (!progress.waiting && progress.phase !== "tool") progress.phase = "thinking"
      return
    case "text":
      if (!progress.waiting) progress.phase = "writing"
      return
    case "status":
    case "session":
      return
    case "done":
      if (event.usage) progress.usage = event.usage
      return
    case "error":
      progress.lastError = clip(event.message, 300)
      pushStep(progress, now, clip(`error: ${event.message}`, MAX_LINE), false)
      return
    case "tool":
      trackTool(progress, event, now)
  }
}

function trackTool(
  progress: RunProgress,
  event: Extract<AgentStreamEvent, { type: "tool" }>,
  now: number
) {
  const known = progress.inputs.get(event.id)
  const input = event.input ?? known?.input
  const name = event.name || known?.name || "tool"
  progress.inputs.set(event.id, { name, input })

  if (event.status === "running") {
    if (isOpenUserRequestTool({ name, status: "running", input })) {
      const request = parseUserRequestInput(input)
      progress.waiting = {
        id: event.id,
        kind: request?.kind ?? "question",
        title: clip(request?.title ?? "", MAX_LINE),
      }
      progress.phase = "waiting_on_user"
      return
    }
    progress.current = describeTool(name, input)
    progress.phase = "tool"
    return
  }

  // The call settled: whatever it was, it is no longer what is happening.
  progress.inputs.delete(event.id)
  if (progress.waiting?.id === event.id) progress.waiting = undefined
  progress.current = undefined
  progress.phase = "thinking"

  const ok = event.status === "done" && (event.exitCode === undefined || event.exitCode === 0)
  const args = parseArgs(input)
  let line = describeTool(name, input)

  if (isShellTool(name)) {
    progress.commands += 1
    if (!ok) progress.failedCommands += 1
    const command = extractToolCommand(args)
    if (command && looksLikeTestCommand(command)) {
      if (ok) progress.tests.passed += 1
      else progress.tests.failed += 1
    }
    if (typeof event.exitCode === "number") line += ` → exit ${event.exitCode}`
  } else if (event.status === "done" && isEditTool(name)) {
    for (const path of collectToolPaths(args, { maxPaths: 8 })) {
      progress.edited.set(path, (progress.edited.get(path) ?? 0) + 1)
    }
  } else if (event.status === "done" && isReadTool(name)) {
    progress.readCount += 1
  }

  if (event.status === "error") {
    progress.toolErrors += 1
    const reason = event.output?.trim()
    if (reason) progress.lastError = clip(`${name}: ${reason}`, 300)
    line += " ✗"
  }
  pushStep(progress, now, line, ok)
}

export function finishProgress(progress: RunProgress, now: number) {
  progress.phase = "finished"
  progress.current = undefined
  progress.waiting = undefined
  progress.lastEventAt = now
}

export type DigestOptions = {
  /** `brief` is the poll; `full` adds the step log and the latest output. */
  detail?: "brief" | "full"
  /** Only log steps after this one — the cursor a previous digest returned. */
  sinceStep?: number
  /** The subagent's text so far, for `full`. */
  output?: string
}

/**
 * The compact view. Every field is omitted when it says nothing, so a quiet
 * run costs a handful of keys.
 */
export function digestProgress(
  progress: RunProgress,
  now: number,
  options: DigestOptions = {}
): Record<string, unknown> {
  const edited = [...progress.edited.keys()]
  const digest: Record<string, unknown> = {
    phase: progress.phase,
    ...(progress.current ? { doing: progress.current } : null),
    ...(progress.phase !== "finished" && progress.phase !== "queued"
      ? { idle_seconds: Math.max(0, Math.round((now - progress.lastEventAt) / 1000)) }
      : null),
    ...(progress.waiting
      ? {
          waiting_on_user: {
            kind: progress.waiting.kind,
            ...(progress.waiting.title ? { title: progress.waiting.title } : null),
          },
        }
      : null),
    steps: progress.stepCount,
    ...(edited.length
      ? {
          files_edited: edited.slice(0, MAX_DIGEST_PATHS),
          ...(edited.length > MAX_DIGEST_PATHS
            ? { files_edited_more: edited.length - MAX_DIGEST_PATHS }
            : null),
        }
      : null),
    ...(progress.readCount ? { files_read: progress.readCount } : null),
    ...(progress.commands
      ? {
          commands: progress.commands,
          ...(progress.failedCommands ? { commands_failed: progress.failedCommands } : null),
        }
      : null),
    ...(progress.tests.passed || progress.tests.failed
      ? { test_runs: { passed: progress.tests.passed, failed: progress.tests.failed } }
      : null),
    ...(progress.toolErrors ? { tool_errors: progress.toolErrors } : null),
    ...(progress.lastError ? { last_error: progress.lastError } : null),
    ...(progress.usage && (progress.usage.input || progress.usage.output)
      ? {
          tokens: {
            ...(progress.usage.input ? { in: progress.usage.input } : null),
            ...(progress.usage.output ? { out: progress.usage.output } : null),
          },
        }
      : null),
  }

  const wantsLog = options.detail === "full" || options.sinceStep !== undefined
  if (wantsLog) {
    const since = options.sinceStep ?? 0
    const fresh = progress.steps.filter((step) => step.n > since)
    const log =
      options.sinceStep === undefined ? fresh.slice(-DEFAULT_LOG_LINES) : fresh
    const dropped = progress.steps.length && progress.steps[0].n > since + 1
    digest.log = log.map((step) => `#${step.n} +${step.t}s ${step.line}`)
    if (dropped || log.length < fresh.length) digest.log_truncated = true
  }
  if (options.detail === "full" && options.output?.trim()) {
    const output = options.output.trim()
    digest.latest_output =
      output.length > OUTPUT_TAIL_CHARS ? `…${output.slice(-OUTPUT_TAIL_CHARS)}` : output
  }
  return digest
}
