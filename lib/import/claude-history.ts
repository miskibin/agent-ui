import "server-only"

import { homedir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"

import {
  cwdOf,
  count,
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
 * Claude Code's own history: `~/.claude/projects/<escaped-path>/<uuid>.jsonl`,
 * one file per conversation, one JSON record per line.
 *
 * The directory name is an escaped spelling of the folder and is deliberately
 * *not* decoded — it is lossy (every separator and dot becomes a dash, and
 * nothing says which was which). Every transcript records its own `cwd`, so
 * the folder is read out of the file rather than guessed from its path.
 *
 * The file name is the conversation's session id, which is also what
 * `claude --resume` takes — so an imported chat can be continued here, by the
 * `claudeCode` provider, rather than only read.
 *
 * Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
 */

/**
 * Where the CLI keeps it. `CLAUDE_CONFIG_DIR` is the same override the CLI
 * itself reads, so a user who moved their config is scanned where they moved
 * it to; `~` is expanded because that variable is routinely written with one.
 */
export function claudeConfigDir(): string {
  const configured = str(process.env.CLAUDE_CONFIG_DIR)
  if (configured) {
    const expanded =
      configured === "~" ||
      configured.startsWith("~/") ||
      configured.startsWith("~\\")
        ? `${homedir()}${configured.slice(1)}`
        : configured
    return resolve(expanded)
  }
  return join(homedir(), ".claude")
}

export function claudeProjectsDir(): string {
  return join(claudeConfigDir(), "projects")
}

export type ClaudeScan = {
  /** Transcripts grouped by the folder they recorded, newest first. */
  byCwd: Map<string, TranscriptFile[]>
  truncated: boolean
}

/**
 * Group every transcript by the folder it ran in.
 *
 * Discovery is newest-first and capped, so a home with years of history is
 * summarized rather than walked to the end — and what the cap drops is the
 * oldest of it.
 */
export async function scanClaudeTranscripts(): Promise<ClaudeScan> {
  const budget = newDiscoveryBudget()
  const found = await walkTranscripts(claudeProjectsDir(), 1, budget)
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

/** The picker's rows: one per folder, newest first. */
export function claudeProjects(scan: ClaudeScan): ImportProject[] {
  return [...scan.byCwd.entries()]
    .map(([cwd, files]) => ({
      cwd,
      provider: "claude-code" as const,
      conversations: files.length,
      lastActiveAt: files.reduce((newest, file) => Math.max(newest, file.mtimeMs), 0),
      resumable: true,
    }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.cwd.localeCompare(b.cwd))
}

/** Read and parse one transcript; `null` when there is nothing to import. */
export async function loadClaudeConversation(
  file: TranscriptFile
): Promise<ImportedConversation | null> {
  const records = await readRecords(file)
  if (!records) return null
  return parseClaudeTranscript(records, {
    sourcePath: file.path,
    fallbackSessionId: basename(file.path, ".jsonl"),
    mtimeMs: file.mtimeMs,
  })
}

/**
 * Keep the visible conversation and nothing else.
 *
 * What is dropped is most of the file: sidechains (a subagent's own
 * transcript, interleaved with the parent's), meta and hook records the CLI
 * writes on the user's behalf, compaction summaries, and every `tool_use` /
 * `tool_result` block — a Read of a large file is megabytes of content the
 * user never saw as a message. What is left is the text turns, which is what
 * someone continuing the conversation here wants to look at.
 */
export function parseClaudeTranscript(
  records: Record<string, unknown>[],
  meta: { sourcePath: string; fallbackSessionId: string; mtimeMs: number }
): ImportedConversation | null {
  const messages: ImportedMessage[] = []
  let cwd = ""
  let sessionId = ""
  let model = ""

  for (const record of records) {
    if (!cwd) cwd = cwdOf(record) ?? ""
    if (
      record.isSidechain === true ||
      record.isMeta === true ||
      record.isCompactSummary === true
    ) {
      continue
    }
    const recordSessionId = str(record.sessionId)
    if (recordSessionId) sessionId = recordSessionId

    const message = obj(record.message)
    const recordModel = str(message?.model)
    // The CLI's sentinel for a locally generated error reply. It is not a
    // model id, and offering it in the picker would break the first turn.
    if (recordModel && recordModel !== "<synthetic>") model = recordModel

    const type = str(record.type)
    if (type !== "user" && type !== "assistant") continue
    // A user record carrying tool output is the CLI talking to itself.
    if (record.toolUseResult !== undefined) continue

    const text = visibleText(message?.content)
    if (!text) continue

    messages.push({
      role: type,
      text,
      at: timestampMs(record.timestamp, meta.mtimeMs),
      ...(type === "assistant" && recordModel && recordModel !== "<synthetic>"
        ? { model: recordModel }
        : null),
      ...(type === "assistant" ? usageOf(message?.usage) : null),
    })
    // Keep the newest turns: a long conversation's tail is the part someone
    // resuming it needs to see.
    if (messages.length > MAX_IMPORTED_MESSAGES) messages.shift()
  }

  const firstUser = messages.find((entry) => entry.role === "user")
  if (!firstUser || !cwd) return null

  const resumeId = isResumableSessionId(sessionId)
    ? sessionId
    : isResumableSessionId(meta.fallbackSessionId)
      ? meta.fallbackSessionId
      : ""

  return {
    provider: "claude-code",
    ...(resumeId ? { sessionId: resumeId } : null),
    cwd,
    title: titleFrom(firstUser.text) || "Imported conversation",
    ...(model ? { model } : null),
    createdAt: messages[0]?.at ?? meta.mtimeMs,
    updatedAt: meta.mtimeMs,
    messages,
    sourcePath: meta.sourcePath,
  }
}

/**
 * Text the user actually saw. A block list is filtered to its text blocks —
 * `tool_use`, `tool_result`, `thinking` and the image blocks an attachment
 * becomes are all content of the run, not of the conversation.
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

/** The `usage` object an assistant record carries, when it carries one. */
function usageOf(value: unknown): Pick<ImportedMessage, "usage"> | null {
  const usage = obj(value)
  if (!usage) return null
  const inputTokens = count(usage.input_tokens)
  const outputTokens = count(usage.output_tokens)
  const cachedInputTokens = count(usage.cache_read_input_tokens)
  const cacheCreationTokens = count(usage.cache_creation_input_tokens)
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return null
  }
  return {
    usage: {
      ...(inputTokens !== undefined ? { inputTokens } : null),
      ...(outputTokens !== undefined ? { outputTokens } : null),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : null),
      ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : null),
    },
  }
}
