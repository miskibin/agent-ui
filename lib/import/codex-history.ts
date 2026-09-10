import "server-only"

import { homedir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"

import {
  cwdOf,
  isResumableSessionId,
  MAX_IMPORTED_MESSAGES,
  MAX_TRANSCRIPTS_PER_SCAN,
  newDiscoveryBudget,
  newestFirst,
  obj,
  readCwd,
  readRecords,
  str,
  timestampMs,
  titleFrom,
  walkTranscripts,
  type TranscriptFile,
} from "@/lib/import/jsonl"
import type {
  ImportedConversation,
  ImportedMessage,
  ImportProject,
} from "@/lib/import/types"

/**
 * Codex's own history: `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`,
 * date-partitioned, one rollout file per conversation.
 *
 * The format is not Claude's. A rollout is a log of *events*, and the same
 * prompt can appear twice in it — once as the `event_msg` the UI showed and
 * once as the `response_item` that went to the model — so the parse below
 * de-duplicates within a turn rather than trusting either copy alone.
 *
 * The imported session id is retained for the Codex provider to resume through
 * app-server. Parsing itself only reads the rollout; importing never starts a
 * Codex turn or changes the original conversation.
 *
 * Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
 */

/** `CODEX_HOME` is the CLI's own override, and is honoured for the same reason. */
export function codexHomeDir(): string {
  const configured = str(process.env.CODEX_HOME)
  if (configured) {
    const expanded =
      configured === "~" ||
      configured.startsWith("~/") ||
      configured.startsWith("~\\")
        ? `${homedir()}${configured.slice(1)}`
        : configured
    return resolve(expanded)
  }
  return join(homedir(), ".codex")
}

export function codexSessionsDir(): string {
  return join(codexHomeDir(), "sessions")
}

export type CodexScan = {
  byCwd: Map<string, TranscriptFile[]>
  truncated: boolean
}

function isRollout(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl")
}

export async function scanCodexTranscripts(): Promise<CodexScan> {
  const budget = newDiscoveryBudget()
  // year / month / day, so three directories below `sessions`.
  const found = await walkTranscripts(codexSessionsDir(), 3, budget, isRollout)
  const ordered = newestFirst(found)
  let truncated = budget.truncated
  if (ordered.length > MAX_TRANSCRIPTS_PER_SCAN) truncated = true

  const byCwd = new Map<string, TranscriptFile[]>()
  for (const file of ordered.slice(0, MAX_TRANSCRIPTS_PER_SCAN)) {
    const cwd = await readCwd(file)
    if (!cwd || !isAbsolute(cwd)) continue
    const existing = byCwd.get(cwd)
    if (existing) existing.push(file)
    else byCwd.set(cwd, [file])
  }
  return { byCwd, truncated }
}

export function codexProjects(scan: CodexScan): ImportProject[] {
  return [...scan.byCwd.entries()]
    .map(([cwd, files]) => ({
      cwd,
      provider: "codex" as const,
      conversations: files.length,
      lastActiveAt: files.reduce((newest, file) => Math.max(newest, file.mtimeMs), 0),
      resumable: true,
    }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.cwd.localeCompare(b.cwd))
}

export async function loadCodexConversation(
  file: TranscriptFile
): Promise<ImportedConversation | null> {
  const records = await readRecords(file)
  if (!records) return null
  return parseCodexTranscript(records, {
    sourcePath: file.path,
    fallbackSessionId: sessionIdFromName(basename(file.path, ".jsonl")),
    mtimeMs: file.mtimeMs,
  })
}

/**
 * A rollout's name is `rollout-<iso timestamp>-<uuid>`, so the id is its tail
 * — unlike Claude, where the whole basename is the id.
 */
export function sessionIdFromName(name: string): string {
  const tail = name.slice(-36)
  return isResumableSessionId(tail) ? tail : ""
}

/** The visible conversation, out of the event log. */
export function parseCodexTranscript(
  records: Record<string, unknown>[],
  meta: { sourcePath: string; fallbackSessionId: string; mtimeMs: number }
): ImportedConversation | null {
  /** `fromResponseItem` marks the copy that a matching event supersedes. */
  const messages: (ImportedMessage & { fromResponseItem: boolean })[] = []
  let cwd = ""
  let sessionId = ""
  let model = ""

  const retain = (message: ImportedMessage & { fromResponseItem: boolean }) => {
    messages.push(message)
    if (messages.length > MAX_IMPORTED_MESSAGES) messages.shift()
  }

  /**
   * Whether the user text already arrived as an event in *this* turn. The walk
   * stops at the previous assistant message: the same prompt sent twice in one
   * conversation is two messages, the same prompt logged twice inside one turn
   * is one.
   */
  const seenAsEventThisTurn = (text: string) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role === "assistant") return false
      if (
        message.role === "user" &&
        !message.fromResponseItem &&
        message.text === text
      ) {
        return true
      }
    }
    return false
  }

  for (const record of records) {
    if (!cwd) cwd = cwdOf(record) ?? ""
    const type = str(record.type)
    const payload = obj(record.payload)
    const at = timestampMs(record.timestamp, meta.mtimeMs)

    if (type === "session_meta") {
      if (!sessionId) sessionId = str(payload?.id) || str(payload?.session_id)
      continue
    }
    if (type === "turn_context") {
      const turnModel = str(payload?.model)
      if (turnModel) model = turnModel
      continue
    }
    if (type === "event_msg" && str(payload?.type) === "user_message") {
      const text = str(payload?.message)
      if (!text) continue
      // Drop the response-item copy of this same prompt, if one came first.
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message.role === "assistant") break
        if (message.fromResponseItem && message.text === text) {
          messages.splice(index, 1)
          break
        }
      }
      retain({ role: "user", text, at, fromResponseItem: false })
      continue
    }
    if (type !== "response_item" || str(payload?.type) !== "message") continue

    const role = str(payload?.role)
    if (role !== "user" && role !== "assistant") continue
    const text = visibleText(payload?.content)
    if (!text) continue
    if (role === "user" && seenAsEventThisTurn(text)) continue
    retain({
      role,
      text,
      at,
      ...(role === "assistant" && model ? { model } : null),
      fromResponseItem: role === "user",
    })
  }

  const visible: ImportedMessage[] = messages.map((message) => ({
    role: message.role,
    text: message.text,
    at: message.at,
    ...(message.model ? { model: message.model } : null),
    ...(message.usage ? { usage: message.usage } : null),
  }))
  const firstUser = visible.find((entry) => entry.role === "user")
  if (!firstUser || !cwd) return null

  const resumeId = isResumableSessionId(sessionId)
    ? sessionId
    : meta.fallbackSessionId

  return {
    provider: "codex",
    ...(resumeId ? { sessionId: resumeId } : null),
    cwd,
    title: titleFrom(firstUser.text) || "Imported conversation",
    ...(model ? { model } : null),
    createdAt: visible[0]?.at ?? meta.mtimeMs,
    updatedAt: meta.mtimeMs,
    messages: visible,
    sourcePath: meta.sourcePath,
  }
}

/**
 * Codex names its text blocks `input_text` and `output_text`; everything else
 * in a `content` array is a tool call, a reasoning trace or an attachment.
 */
function visibleText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .map((entry) => {
      const block = obj(entry)
      if (!block) return ""
      const type = str(block.type)
      if (type !== "text" && type !== "input_text" && type !== "output_text") {
        return ""
      }
      return str(block.text)
    })
    .filter((text) => text.length > 0)
    .join("\n")
    .trim()
}
