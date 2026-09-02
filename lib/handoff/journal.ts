import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import type {
  JournalEvent,
  JournalTool,
  NewJournalEvent,
} from "@/lib/handoff/types"

/**
 * The chat's event journal: what happened, not what was said.
 *
 * A transcript already exists — this is the far smaller thing a *returning*
 * agent needs, so it deliberately stores no streamed text, no thinking and no
 * tool output. Every helper here is pure; `lib/store/sessions` owns the file
 * and is the only place a seq is ever handed out.
 */

/**
 * Events kept per chat. Bounded because the journal is append-only and a long
 * chat would otherwise grow one entry per tool call forever; the oldest are
 * dropped first, which is also the order a handoff sheds detail under budget.
 */
export const JOURNAL_CAP = 500

/** Longest user message text kept — a handoff quotes requests, not essays. */
export const MAX_JOURNAL_TEXT = 400
/** Longest command line kept. */
export const MAX_JOURNAL_COMMAND = 300
/** Longest error message kept. */
export const MAX_JOURNAL_ERROR = 300
/** Most file paths kept per tool call. */
export const MAX_JOURNAL_PATHS = 8

/** Last seq in the journal; 0 for an empty one. */
export function lastSeq(events: JournalEvent[]) {
  return events.length > 0 ? events[events.length - 1].seq : 0
}

/**
 * Numbers `incoming` after `existing` and returns the capped journal. Seqs
 * survive the cap — they index the agents' cursors, so they must never be
 * renumbered when the front of the journal is dropped.
 */
export function appendEvents(
  existing: JournalEvent[],
  incoming: NewJournalEvent[],
  cap: number = JOURNAL_CAP
): JournalEvent[] {
  let seq = lastSeq(existing)
  const now = Date.now()
  const numbered = incoming.map((event) => ({
    ...event,
    seq: ++seq,
    at: event.at ?? now,
  })) as JournalEvent[]
  return capJournal([...existing, ...numbered], cap)
}

/** Keeps the newest `cap` events, oldest dropped first. */
export function capJournal(
  events: JournalEvent[],
  cap: number = JOURNAL_CAP
): JournalEvent[] {
  const limit = Math.max(1, Math.trunc(cap))
  return events.length <= limit ? events : events.slice(events.length - limit)
}

/** Drops anything that is not a well-formed event — a broken file is not fatal. */
export function normalizeJournal(raw: unknown): JournalEvent[] {
  if (!Array.isArray(raw)) return []
  const events: JournalEvent[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const value = entry as Record<string, unknown>
    if (typeof value.seq !== "number" || !Number.isFinite(value.seq)) continue
    if (typeof value.providerId !== "string") continue
    const at = typeof value.at === "number" ? value.at : 0
    const base = { seq: value.seq, at, providerId: value.providerId }
    if (value.kind === "user-message" && typeof value.text === "string") {
      events.push({ ...base, kind: "user-message", text: value.text })
      continue
    }
    if (value.kind === "tool" && typeof value.name === "string") {
      if (value.status !== "done" && value.status !== "error") continue
      events.push({
        ...base,
        kind: "tool",
        name: value.name,
        status: value.status,
        ...(Array.isArray(value.paths)
          ? { paths: value.paths.filter((p): p is string => typeof p === "string") }
          : null),
        ...(typeof value.command === "string" ? { command: value.command } : null),
        ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : null),
      })
      continue
    }
    if (value.kind === "turn-end") {
      const outcome = value.outcome
      if (outcome !== "ok" && outcome !== "error" && outcome !== "aborted") {
        continue
      }
      events.push({
        ...base,
        kind: "turn-end",
        model: typeof value.model === "string" ? value.model : "",
        outcome,
        ...(typeof value.error === "string" ? { error: value.error } : null),
      })
    }
  }
  // A hand-edited or partially written file could hand back seqs out of order,
  // and every cursor rule downstream assumes they ascend.
  return events.sort((a, b) => a.seq - b.seq)
}

/* -------------------------------------------------------------------------- */
/* Deriving events from a run                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One tool event as the journal keeps it, or null for the ones it does not:
 * a `running` row (nothing has happened yet) and the plan pseudo-tool the ACP
 * provider folds a plan into (it is UI, not work).
 */
export function toolJournalEvent(
  event: Extract<AgentStreamEvent, { type: "tool" }>
): Omit<JournalTool, "kind"> | null {
  if (event.status !== "done" && event.status !== "error") return null
  const name = event.name.trim() || "tool"
  if (isPlanTool(name)) return null
  const args = parseArgs(event.input)
  const paths = toolPaths(args)
  const command = isShellTool(name) ? asString(args.command, args.cmd, args.script) : undefined
  return {
    name,
    status: event.status,
    ...(paths.length ? { paths } : null),
    ...(command ? { command: clip(command, MAX_JOURNAL_COMMAND) } : null),
    ...(typeof event.exitCode === "number" ? { exitCode: event.exitCode } : null),
  }
}

/** The user's own words, trimmed to the journal's budget. */
export function userJournalText(prompt: string) {
  return clip(prompt, MAX_JOURNAL_TEXT)
}

/** Same vocabulary the vendored tool rows use to recognise a shell call. */
export function isShellTool(name: string) {
  const kind = name.replace(/\s+/g, "").toLowerCase()
  return (
    kind.includes("shell") ||
    kind.includes("bash") ||
    kind.includes("terminal") ||
    kind === "command" ||
    kind === "run" ||
    kind === "exec" ||
    kind === "runcommand" ||
    kind === "executecommand"
  )
}

function isPlanTool(name: string) {
  const kind = name.replace(/\s+/g, "").toLowerCase()
  return kind === "plan" || kind === "todo" || kind === "todowrite"
}

/**
 * Commands worth calling out as a test run. A heuristic on the command text,
 * kept narrow: a false positive here mislabels a section of the handoff.
 */
const TEST_COMMAND =
  /(^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(run\s+)?test|(^|[\s;&|(])(vitest|jest|pytest|mocha|ava|tox|phpunit|rspec)\b|(^|[\s;&|(])(cargo|go|dotnet|mix|swift)\s+test\b|(^|[\s;&|(])python\s+-m\s+(pytest|unittest)\b|(^|[\s;&|(])(gradlew?|mvn)\s+.*\btest\b|(^|[\s;&|(])make\s+test\b/i

export function looksLikeTestCommand(command: string) {
  return TEST_COMMAND.test(command)
}

/** File paths a call named, under the argument spellings the harnesses use. */
function toolPaths(args: Record<string, unknown>): string[] {
  const found: string[] = []
  const push = (value: unknown) => {
    if (typeof value !== "string") return
    const path = value.trim()
    if (!path || found.includes(path)) return
    if (found.length < MAX_JOURNAL_PATHS) found.push(path)
  }
  push(args.path)
  push(args.filePath)
  push(args.file_path)
  push(args.target_file)
  push(args.file)
  push(args.abs_path)
  if (Array.isArray(args.paths)) for (const entry of args.paths) push(entry)
  if (Array.isArray(args.files)) for (const entry of args.files) push(entry)
  return found
}

function parseArgs(input: string | undefined): Record<string, unknown> {
  if (!input) return {}
  try {
    const value = JSON.parse(input) as unknown
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    /* a raw string argument carries no fields to read */
  }
  return {}
}

function asString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

/** One line, budgeted — the journal never stores a wall of text. */
export function clip(text: string, max: number) {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}
