import "server-only"

import { open, readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

/**
 * Reading a CLI's transcript directory without letting it read us.
 *
 * A history home is not our data: it can hold thousands of files, a single
 * transcript can be gigabytes of screenshots pasted into tool results, and a
 * half-written line is normal rather than exceptional. So every read here is
 * bounded twice — once per file and once per scan — and every failure is a
 * skip. A malformed line, an unreadable directory or a file that grew between
 * the stat and the read costs that one transcript, never the import.
 *
 * Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
 */

/** Past this a transcript is not worth parsing to show someone their history. */
export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024

/** Per folder, so one busy project cannot spend the whole import. */
export const MAX_CONVERSATIONS_PER_PROJECT = 100
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024

/** Lines parsed out of one transcript before it is given up on. */
export const MAX_RECORDS = 100_000

/** Visible turns kept per conversation — the newest ones. */
export const MAX_IMPORTED_MESSAGES = 200

/**
 * How far into a transcript the folder is looked for. Claude writes `cwd` on
 * the first record and Codex on its `session_meta`, so this is generous; what
 * it really bounds is the file that never names one.
 */
const MAX_CWD_SCAN_BYTES = 1024 * 1024

/** Files inspected per scan, newest first — the cap drops only stale ones. */
export const MAX_TRANSCRIPTS_PER_SCAN = 5000

/** Directory reads per scan. Discovery has to stat before it can order. */
const MAX_DISCOVERY_OPERATIONS = MAX_TRANSCRIPTS_PER_SCAN * 4

export type TranscriptFile = {
  path: string
  size: number
  mtimeMs: number
}

/** Mutable budget threaded through one discovery walk. */
export type DiscoveryBudget = {
  operations: number
  truncated: boolean
}

export function newDiscoveryBudget(): DiscoveryBudget {
  return { operations: MAX_DISCOVERY_OPERATIONS, truncated: false }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/**
 * Every `*.jsonl` under `dir`, at most `depth` directories down.
 *
 * Entries are walked in reverse name order because both CLIs name their
 * directories chronologically (Codex partitions by year/month/day, Claude by
 * an escaped project path that at least groups a project's files together) —
 * so when the budget runs out it is the oldest history that is missing.
 */
export async function walkTranscripts(
  dir: string,
  depth: number,
  budget: DiscoveryBudget,
  accept: (name: string) => boolean = (name) => name.endsWith(".jsonl")
): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = []
  if (budget.operations <= 0) {
    budget.truncated = true
    return found
  }
  budget.operations -= 1
  const entries = (await listDir(dir)).sort().reverse()

  for (const entry of entries) {
    if (budget.operations <= 0) {
      budget.truncated = true
      break
    }
    const path = join(dir, entry)
    if (accept(entry)) {
      budget.operations -= 1
      const info = await stat(path).catch(() => null)
      if (info?.isFile()) {
        found.push({ path, size: info.size, mtimeMs: info.mtimeMs })
        continue
      }
      // Not a file after all — fall through and try it as a directory.
    }
    if (depth > 0) {
      const info = await stat(path).catch(() => null)
      if (info?.isDirectory()) {
        found.push(...(await walkTranscripts(path, depth - 1, budget, accept)))
      }
    }
  }
  return found
}

/**
 * The transcripts of one folder an import will actually read: the newest
 * `MAX_CONVERSATIONS_PER_PROJECT`, and only while they fit the folder's byte
 * budget. Both caps exist so one project with a decade of history cannot turn
 * "import this folder" into an unbounded read.
 */
export function selectForImport(files: TranscriptFile[]): TranscriptFile[] {
  const selected: TranscriptFile[] = []
  let bytes = 0
  for (const file of newestFirst(files)) {
    if (selected.length >= MAX_CONVERSATIONS_PER_PROJECT) break
    if (bytes + file.size > MAX_PROJECT_BYTES) break
    bytes += file.size
    selected.push(file)
  }
  return selected
}

/** Newest first, ties broken by path so a scan is deterministic. */
export function newestFirst(files: TranscriptFile[]): TranscriptFile[] {
  return [...files].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path)
  )
}

/** One line of JSON, or null — a half-written record is not an error. */
export function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed[0] !== "{") return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * The folder a transcript recorded, from a bounded read of its head.
 *
 * Both CLIs put it in the first record they write; the two spellings — the
 * top-level `cwd` Claude uses and the `payload.cwd` Codex nests — are the only
 * ones read, because guessing at a third is how a scan starts inventing
 * folders.
 */
export async function readCwd(file: TranscriptFile): Promise<string | null> {
  if (file.size === 0) return null
  const handle = await open(file.path, "r").catch(() => null)
  if (!handle) return null
  try {
    const length = Math.min(MAX_CWD_SCAN_BYTES, file.size)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const text = buffer.subarray(0, bytesRead).toString("utf8")
    const lines = text.split("\n")
    // The tail is only a whole record when the read reached the end of file.
    if (bytesRead < file.size) lines.pop()
    for (const line of lines) {
      const cwd = cwdOf(parseLine(line))
      if (cwd) return cwd
    }
    return null
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

/** `cwd`, or the `payload.cwd` Codex nests it under. */
export function cwdOf(record: Record<string, unknown> | null): string | null {
  if (!record) return null
  const top = str(record.cwd)
  if (top) return top
  const payload = record.payload
  if (typeof payload === "object" && payload !== null) {
    const nested = str((payload as Record<string, unknown>).cwd)
    if (nested) return nested
  }
  return null
}

/**
 * Every record of one transcript, or `null` when it is too big, unreadable or
 * longer than `MAX_RECORDS` lines. Rejecting the file whole is deliberate:
 * half a conversation imported as if it were all of it is worse than none.
 */
export async function readRecords(
  file: TranscriptFile
): Promise<Record<string, unknown>[] | null> {
  if (file.size > MAX_TRANSCRIPT_BYTES || file.size === 0) return null
  const text = await readFile(file.path, "utf8").catch(() => null)
  if (text === null) return null
  const lines = text.split("\n")
  if (lines.length > MAX_RECORDS + 1) return null
  const records: Record<string, unknown>[] = []
  for (const line of lines) {
    const parsed = parseLine(line)
    if (parsed) records.push(parsed)
  }
  return records
}

/* -------------------------------------------------------------------------- */
/* Field readers                                                               */
/* -------------------------------------------------------------------------- */

export function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A token count: a positive finite number, or nothing at all. */
export function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined
}

export function timestampMs(value: unknown, fallback: number): number {
  const text = str(value)
  if (!text) return fallback
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? fallback : parsed
}

/**
 * The one id shape `--resume` will take: a UUID, which is what both CLIs mint.
 * Anything else is a file name we guessed at, and handing that to a `--resume`
 * flag starts a turn that dies on the first token.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isResumableSessionId(value: string): boolean {
  return UUID.test(value)
}

/** First line of the first thing the user said, as the chat's name. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? ""
  return line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line
}
