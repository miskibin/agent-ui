import "server-only"

import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { writeFileAtomic } from "@/lib/atomic-write"
import { dataDir } from "@/lib/settings/server"
import { isImportProvider, type ImportProvider } from "@/lib/import/types"

/**
 * Which chats came from somewhere else — `~/.agent-ui/imports.json`.
 *
 * Two things need this, and neither can be answered from the sessions index
 * alone. **Dedupe**: a second import must not create a second copy of a
 * conversation, and the identity that says so is the CLI's own session id —
 * which for Codex is never written to the index, because nothing here can
 * resume it. **The badge**: a chat that was imported reads differently from
 * one that happened here, and the sidebar should be able to say so without
 * opening a transcript.
 *
 * Its own file rather than a field on `SessionMeta` for the same reason the
 * journal is: the index is read on every page load and is the app's hottest
 * file, while this is read twice — once by the import dialog, once by whoever
 * draws the badge.
 */

const LEDGER_VERSION = 1

/** Old entries are dropped rather than kept forever; the newest win. */
const MAX_ENTRIES = 5000

export type ImportLedgerEntry = {
  /** The chat this app created for it. */
  sessionId: string
  provider: ImportProvider
  /** The CLI's own conversation id — the dedupe key. */
  providerSessionId: string
  /** Transcript it was read from, for a later "re-import what changed". */
  sourcePath?: string
  importedAt: number
}

export type ImportLedger = {
  version: number
  entries: ImportLedgerEntry[]
}

function ledgerPath() {
  return join(dataDir(), "imports.json")
}

function normalizeEntry(raw: unknown): ImportLedgerEntry | null {
  if (typeof raw !== "object" || raw === null) return null
  const value = raw as Record<string, unknown>
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : ""
  const providerSessionId =
    typeof value.providerSessionId === "string" ? value.providerSessionId : ""
  if (!sessionId || !providerSessionId || !isImportProvider(value.provider)) {
    return null
  }
  return {
    sessionId,
    provider: value.provider,
    providerSessionId,
    ...(typeof value.sourcePath === "string"
      ? { sourcePath: value.sourcePath }
      : null),
    importedAt:
      typeof value.importedAt === "number" ? value.importedAt : Date.now(),
  }
}

export async function readLedger(): Promise<ImportLedger> {
  try {
    const parsed: unknown = JSON.parse(await readFile(ledgerPath(), "utf8"))
    const entries = (parsed as { entries?: unknown })?.entries
    if (!Array.isArray(entries)) return { version: LEDGER_VERSION, entries: [] }
    return {
      version: LEDGER_VERSION,
      entries: entries
        .map(normalizeEntry)
        .filter((entry): entry is ImportLedgerEntry => entry !== null),
    }
  } catch {
    return { version: LEDGER_VERSION, entries: [] }
  }
}

/**
 * Appends this run's entries, drops the ones whose chat no longer exists, and
 * keeps the newest `MAX_ENTRIES`. `liveSessionIds` is passed in rather than
 * read here so the caller does one index read for the whole import.
 */
export async function appendLedger(
  added: ImportLedgerEntry[],
  liveSessionIds: Set<string>
): Promise<void> {
  const existing = await readLedger()
  const kept = existing.entries.filter((entry) =>
    liveSessionIds.has(entry.sessionId)
  )
  const entries = [...kept, ...added]
    .sort((a, b) => a.importedAt - b.importedAt)
    .slice(-MAX_ENTRIES)
  await mkdir(dataDir(), { recursive: true })
  await writeFileAtomic(
    ledgerPath(),
    JSON.stringify({ version: LEDGER_VERSION, entries })
  )
}

/** Provider and the CLI's own session id — the key an import dedupes on. */
export function importKey(
  provider: ImportProvider,
  providerSessionId: string
): string {
  return `${provider} ${providerSessionId}`
}

/** Chat id to where it was imported from, for the sidebar badge. */
export function importedSessions(
  ledger: ImportLedger
): Record<string, ImportProvider> {
  const map: Record<string, ImportProvider> = {}
  for (const entry of ledger.entries) map[entry.sessionId] = entry.provider
  return map
}
