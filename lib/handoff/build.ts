import {
  clip,
  looksLikeTestCommand,
  MAX_JOURNAL_ERROR,
} from "@/lib/handoff/journal"
import {
  snapshotsDiffer,
  type HandoffResult,
  type JournalEvent,
  type WorktreeSnapshot,
} from "@/lib/handoff/types"

/**
 * The handoff block: what the *other* agents did in this chat while this one
 * was away, as one deterministic piece of text.
 *
 * Deterministic matters more than complete. The same journal and the same
 * cursor must always produce the same block — no summarizing model, no
 * ranking, no wall clock in the output — because this rides in front of a
 * prompt on every turn it exists, and an agent that gets a slightly different
 * story each time has no way to tell a real change from noise.
 *
 * Pure: git is read elsewhere (`lib/handoff/snapshot`) and handed in.
 */

/** Character budget for the whole block. */
export const HANDOFF_BUDGET = 8_000

/** Requests quoted back — the newest few, not the whole conversation. */
const MAX_REQUESTS = 3
/** File rows before the list itself is trimmed. */
const MAX_FILE_ROWS = 40
/** Error entries that survive any budget. */
const PROTECTED_ERRORS = 3

/**
 * The one sentence that must always survive truncation: an agent resuming a
 * backend session holds file contents it read before, and acting on those
 * after someone else edited them is the failure this whole feature exists to
 * prevent.
 */
export const STALE_WORKTREE_WARNING =
  "The working tree changed since your last turn. Re-read affected files before editing."

export type HandoffInput = {
  /** The chat's whole journal, oldest first. */
  events: JournalEvent[]
  /** Cursor of the agent about to run. */
  lastSeenSeq: number
  /** Provider about to run — its own events are never handed back to it. */
  providerId: string
  /** The worktree as this agent last left it. */
  snapshot?: WorktreeSnapshot
  /** The worktree now. */
  current?: WorktreeSnapshot
  /** `git diff --stat` rows between the stored head and now, when available. */
  diffStat?: string[]
  maxChars?: number
}

export function buildHandoff(input: HandoffInput): HandoffResult | undefined {
  const delta = input.events.filter(
    (event) =>
      event.seq > input.lastSeenSeq && event.providerId !== input.providerId
  )
  const stale =
    input.snapshot !== undefined &&
    input.current !== undefined &&
    snapshotsDiffer(input.snapshot, input.current)

  if (delta.length === 0 && !stale) return undefined

  const budget = input.maxChars ?? HANDOFF_BUDGET
  const context: RenderContext = {
    stale,
    // A diff against the head this agent last saw is the better answer; the
    // dirty list is the fallback when there is no snapshot to diff from.
    // Kept verbatim: porcelain's two status columns are the difference
    // between a staged and an unstaged edit, and trimming loses it.
    fileRows: (input.diffStat?.length
      ? input.diffStat
      : (input.current?.status ?? [])
    ).filter((row) => row.trim()),
  }

  // Oldest-first shedding: the protected set (the warning, and the newest few
  // errors) is held out of the pool entirely, so the loop can never reach it.
  const protectedSeqs = new Set(
    delta
      .filter(isErrorEvent)
      .slice(-PROTECTED_ERRORS)
      .map((event) => event.seq)
  )
  let kept = delta
  let fileRowLimit = MAX_FILE_ROWS
  let text = render(kept, context, fileRowLimit)

  while (text.length > budget) {
    const index = kept.findIndex((event) => !protectedSeqs.has(event.seq))
    if (index >= 0) {
      kept = [...kept.slice(0, index), ...kept.slice(index + 1)]
    } else if (fileRowLimit > 0) {
      fileRowLimit -= 1
    } else {
      break
    }
    text = render(kept, context, fileRowLimit)
  }
  // Only reachable when the protected content alone overruns, which the
  // per-item clips make practically impossible — but the budget is a promise.
  if (text.length > budget) text = text.slice(0, budget)

  const counts = summarize(kept, context, fileRowLimit)
  return {
    text,
    marker: {
      chars: text.length,
      files: counts.files,
      commands: counts.commands,
      errors: counts.errors,
      staleWorktree: stale,
      text,
    },
    throughSeq: delta.length > 0 ? delta[delta.length - 1].seq : input.lastSeenSeq,
  }
}

type RenderContext = { stale: boolean; fileRows: string[] }

function render(
  events: JournalEvent[],
  context: RenderContext,
  fileRowLimit: number
): string {
  const parts = summarize(events, context, fileRowLimit)
  const lines: string[] = []

  lines.push(
    parts.agents.length > 0
      ? `Another agent worked in this chat since your last turn (${parts.agents.join(", ")}).`
      : "This chat's working folder changed since your last turn."
  )
  if (context.stale) {
    lines.push("")
    lines.push(STALE_WORKTREE_WARNING)
  }

  section(lines, "Requests since then", parts.requests)
  section(lines, "Files changed", parts.fileList)
  section(lines, "Commands run", parts.commandList)
  section(lines, "Test results", parts.testList)
  section(lines, "Errors and unfinished operations", parts.errorList)

  return lines.join("\n")
}

function section(lines: string[], title: string, entries: string[]) {
  if (entries.length === 0) return
  lines.push("")
  lines.push(`${title}:`)
  for (const entry of entries) lines.push(`- ${entry}`)
}

/**
 * Everything the block says, derived once so the renderer and the marker's
 * counts can never disagree.
 */
function summarize(
  events: JournalEvent[],
  context: RenderContext,
  fileRowLimit: number
) {
  const agents: string[] = []
  const requests: string[] = []
  const commandList: string[] = []
  const testList: string[] = []
  const errorList: string[] = []
  const paths: string[] = []

  for (const event of events) {
    if (!agents.includes(event.providerId)) agents.push(event.providerId)
    if (event.kind === "user-message") {
      requests.push(`“${event.text}”`)
      continue
    }
    if (event.kind === "tool") {
      for (const path of event.paths ?? []) addPath(paths, path)
      if (event.command) {
        const line = `${event.command} — ${outcomeOf(event.status, event.exitCode)}`
        commandList.push(line)
        if (looksLikeTestCommand(event.command)) testList.push(line)
      }
      if (event.status === "error") {
        errorList.push(
          `${event.name} failed${event.command ? `: ${event.command}` : describeTarget(event.paths)}`
        )
      }
      continue
    }
    if (event.outcome === "error") {
      errorList.push(
        `turn ended with an error${event.error ? `: ${clip(event.error, MAX_JOURNAL_ERROR)}` : ""}`
      )
    } else if (event.outcome === "aborted") {
      errorList.push("turn was stopped before it finished — work may be half done")
    }
  }

  // The diff (or the dirty list) names files no tool call touched — a script
  // that wrote a chart, a build that regenerated a lockfile.
  const fileList = [...paths]
  const keys = paths.map(pathKey)
  for (const row of context.fileRows) {
    const key = rowKey(row)
    if (keys.some((known) => sameKey(known, key))) continue
    keys.push(key)
    fileList.push(row.trim())
  }

  return {
    agents,
    requests: requests.slice(-MAX_REQUESTS),
    fileList: fileList.slice(0, Math.max(0, fileRowLimit)),
    commandList,
    testList,
    errorList,
    files: Math.min(fileList.length, Math.max(0, fileRowLimit)),
    commands: commandList.length,
    errors: errorList.length,
  }
}

function isErrorEvent(event: JournalEvent) {
  if (event.kind === "tool") return event.status === "error"
  return event.kind === "turn-end" && event.outcome !== "ok"
}

function outcomeOf(status: "done" | "error", exitCode: number | undefined) {
  if (typeof exitCode === "number") {
    return exitCode === 0 ? "exit 0" : `exit ${exitCode} (failed)`
  }
  return status === "error" ? "failed" : "ok"
}

function describeTarget(paths: string[] | undefined) {
  return paths?.length ? `: ${paths[0]}` : ""
}

function addPath(paths: string[], path: string) {
  const key = pathKey(path)
  if (!key || paths.some((known) => sameKey(pathKey(known), key))) return
  paths.push(path)
}

/**
 * The path inside a git row: `lib/foo.ts | 12 +++---` from `diff --stat`, and
 * ` M lib/foo.ts` / `?? out.png` / `R  old -> new` from `status --porcelain`.
 */
function rowKey(row: string) {
  const bar = row.indexOf("|")
  const base =
    bar > 0 ? row.slice(0, bar) : row.replace(/^\s*[A-Z?!]{1,2}\s+/, "")
  const path = base.trim()
  return pathKey(path.split(" -> ").pop() ?? path)
}

/** Case- and separator-insensitive, so Windows paths compare sanely. */
function pathKey(path: string) {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

/** The same file named two ways: one key is the other's tail. */
function sameKey(a: string, b: string) {
  if (!a || !b) return false
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}
