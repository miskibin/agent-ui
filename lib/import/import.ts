import "server-only"

import type { AgentSessionState } from "@/lib/handoff/types"
import {
  claudeProjects,
  loadClaudeConversation,
  scanClaudeTranscripts,
} from "@/lib/import/claude-history"
import {
  codexProjects,
  loadCodexConversation,
  scanCodexTranscripts,
} from "@/lib/import/codex-history"
import { selectForImport, type TranscriptFile } from "@/lib/import/jsonl"
import {
  appendLedger,
  importKey,
  readLedger,
  type ImportLedgerEntry,
} from "@/lib/import/ledger"
import type {
  ImportedConversation,
  ImportProvider,
  ImportRequest,
  ImportResult,
  ImportScanResult,
} from "@/lib/import/types"
import { CLAUDE_CODE_PROVIDER_ID } from "@/lib/providers/claude-code"
import { CODEX_PROVIDER_ID } from "@/lib/providers/codex"
import { createSession, listSessions, writeMessages } from "@/lib/store/sessions"
import type { MessageMetadata, StoredMessage } from "@/lib/store/types"

/**
 * Turning a CLI's history into this app's chats.
 *
 * The scan half is read-only and lives beside each CLI's format; this is the
 * write half, and the only place the two vocabularies meet — the wire's
 * `claude-code` / `codex` and the app's own provider ids.
 *
 * Both CLI providers keep their own conversation history. Import stores the
 * original session id under the matching `agentSessions` key, so the next turn
 * resumes through Claude Code or Codex instead of replaying a copied transcript.
 *
 * Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
 */

/**
 * Which app provider, if any, can carry on one of these conversations. `null`
 * means the history is imported but no session id is stored with it — handing
 * a `--resume` id to a harness that cannot take it is worse than admitting
 * there is nothing to resume.
 */
const RESUMES_AS: Record<ImportProvider, string | null> = {
  "claude-code": CLAUDE_CODE_PROVIDER_ID,
  codex: CODEX_PROVIDER_ID,
}

/** Every folder either CLI has run in, newest first. */
export async function scanImports(): Promise<ImportScanResult> {
  const [claude, codex] = await Promise.all([
    scanClaudeTranscripts(),
    scanCodexTranscripts(),
  ])
  const projects = [...claudeProjects(claude), ...codexProjects(codex)].sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt || a.cwd.localeCompare(b.cwd)
  )
  const truncated = claude.truncated || codex.truncated
  return { projects, ...(truncated ? { truncated: true } : null) }
}

/**
 * Import the conversations the request names. Folders that were never asked
 * for are not read at all; a conversation already imported is counted as
 * skipped and left exactly as it is, including any turns the user has since
 * added to it here.
 */
export async function importConversations(
  request: ImportRequest
): Promise<ImportResult> {
  const provider = request.provider
  const scan =
    provider === "claude-code"
      ? await scanClaudeTranscripts()
      : await scanCodexTranscripts()
  const load =
    provider === "claude-code" ? loadClaudeConversation : loadCodexConversation

  const wantedCwds = request.cwds?.length
    ? new Set(request.cwds.map(normalizeCwd))
    : null
  const wantedIds = request.sessionIds?.length
    ? new Set(request.sessionIds)
    : null

  const files: TranscriptFile[] = []
  for (const [cwd, group] of scan.byCwd) {
    if (wantedCwds && !wantedCwds.has(normalizeCwd(cwd))) continue
    files.push(...selectForImport(group))
  }

  const taken = await alreadyImported()
  const sessions = await listSessions()
  const live = new Set(sessions.map((session) => session.id))
  const added: ImportLedgerEntry[] = []
  let imported = 0
  let skipped = 0

  // Oldest first: `createSession` puts each new chat at the top of the index,
  // so importing in this order leaves the sidebar in the order the
  // conversations actually happened.
  const conversations: ImportedConversation[] = []
  for (const file of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    const conversation = await load(file)
    if (!conversation) {
      skipped += 1
      continue
    }
    if (wantedIds && !(conversation.sessionId && wantedIds.has(conversation.sessionId))) {
      continue
    }
    conversations.push(conversation)
  }

  for (const conversation of conversations) {
    const key = importKey(provider, identityOf(conversation))
    if (taken.has(key)) {
      skipped += 1
      continue
    }
    taken.add(key)
    const sessionId = await writeConversation(conversation)
    if (!sessionId) {
      skipped += 1
      continue
    }
    live.add(sessionId)
    added.push({
      sessionId,
      provider,
      providerSessionId: identityOf(conversation),
      sourcePath: conversation.sourcePath,
      importedAt: Date.now(),
    })
    imported += 1
  }

  if (added.length > 0) await appendLedger(added, live)
  return { imported, skipped }
}

/**
 * What this conversation *is*, for dedupe. The CLI's session id where there is
 * one; otherwise the transcript's path, which is the only other thing that
 * stays the same across two scans of the same history.
 */
function identityOf(conversation: ImportedConversation): string {
  return conversation.sessionId ?? `path:${conversation.sourcePath}`
}

/**
 * Everything a previous import already brought over.
 *
 * Two sources, because neither is complete on its own: the ledger knows every
 * import including the ones with nothing resumable to store, and the sessions
 * index knows the session ids — which is what a chat the user created by
 * resuming a CLI conversation *by hand* would carry, and which should not then
 * be imported a second time underneath it.
 */
async function alreadyImported(): Promise<Set<string>> {
  const taken = new Set<string>()
  const ledger = await readLedger()
  for (const entry of ledger.entries) {
    taken.add(importKey(entry.provider, entry.providerSessionId))
  }
  const sessions = await listSessions()
  for (const session of sessions) {
    for (const [provider, appProviderId] of Object.entries(RESUMES_AS)) {
      if (!appProviderId) continue
      const fromAgentSessions =
        session.agentSessions?.[appProviderId]?.providerSessionId
      const legacy =
        session.providerId === appProviderId
          ? session.providerSessionId
          : undefined
      for (const id of [fromAgentSessions, legacy]) {
        if (id) taken.add(importKey(provider as ImportProvider, id))
      }
    }
  }
  return taken
}

/** Creates the chat and writes its transcript. Returns the new chat's id. */
async function writeConversation(
  conversation: ImportedConversation
): Promise<string | null> {
  const appProviderId = RESUMES_AS[conversation.provider]
  const session = await createSession({
    title: conversation.title,
    // A chat whose backend cannot be resumed is left without one, so the
    // composer's own picker chooses what carries it on from here.
    providerId: appProviderId ?? "",
    model: appProviderId ? (conversation.model ?? "") : "",
    cwd: conversation.cwd,
  })

  const agentSession: AgentSessionState = {
    ...(appProviderId && conversation.sessionId
      ? { providerSessionId: conversation.sessionId }
      : null),
    cwd: conversation.cwd,
    lastSeenSeq: 0,
    lastWroteSeq: 0,
    lastActiveAt: conversation.updatedAt,
  }

  const stored = await writeMessages(
    session.id,
    conversation.messages.map((message, index) =>
      toStoredMessage(message, index, conversation, appProviderId)
    ),
    appProviderId
      ? {
          agentSessions: { [appProviderId]: agentSession },
          // Still written beside `agentSessions`, exactly as a live turn
          // writes it, so an index read by an older build resumes too.
          ...(conversation.sessionId
            ? { providerSessionId: conversation.sessionId }
            : null),
        }
      : {}
  )
  return stored ? session.id : null
}

function toStoredMessage(
  message: ImportedConversation["messages"][number],
  index: number,
  conversation: ImportedConversation,
  appProviderId: string | null
): StoredMessage {
  const metadata: MessageMetadata = {
    ...(message.model ? { model: message.model } : null),
    ...(appProviderId ? { providerId: appProviderId } : null),
    cwd: conversation.cwd,
    finishedAt: message.at,
    ...(message.usage ?? null),
    ...(message.usage
      ? {
          tokens:
            (message.usage.inputTokens ?? 0) + (message.usage.outputTokens ?? 0),
        }
      : null),
    // The user's own words, which for an imported turn is the whole message —
    // the composer's fenced attachments never existed for it.
    ...(message.role === "user" ? { typedText: message.text } : null),
  }
  return {
    id: `import-${index}`,
    content: message.text,
    sender: message.role,
    createdAt: message.at,
    metadata,
  }
}

/** Trailing separators are the one difference between two spellings of a folder. */
function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim().replace(/[\\/]+$/, "")
  return trimmed || cwd.trim()
}
