import type { MessageAttachmentData } from "@/components/ui/message"
import type { ModelOption, ModelPickerGroup } from "@/components/ui/model-picker"
import type { FolderInfo, FolderListing } from "@/lib/folder"
import type { TurnStateFrame } from "@/lib/handoff/types"
import type { MemoryFile, MemoryUpdateResult } from "@/lib/memory/types"
import type { MessageSearchResult } from "@/lib/message-search"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import type {
  PermissionMode,
  ProviderCapabilities,
  ProviderInfo,
} from "@/lib/providers/types"
import { writeSettings } from "@/lib/settings/client"
import { MAX_RECENT_FOLDERS, type AppSettings } from "@/lib/settings/schema"
import { LineBuffer } from "@/lib/stream-framing"
import type { UserRequestAnswer } from "@/lib/turn-requests"
import type { UsageReport } from "@/lib/usage"
import type {
  CreateSessionInput,
  SessionMeta,
  SessionPatch,
  SessionWorktree,
  StoredMessage,
} from "@/lib/store/types"

/**
 * Thin browser wrappers over the app's routes. Everything here is a plain
 * `fetch` so the chat page stays a pure client component — the first paint
 * never waits on the server.
 */

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await errorText(res))
  return (await res.json()) as T
}

async function errorText(res: Response) {
  const body = await res.text().catch(() => "")
  try {
    const parsed = JSON.parse(body) as { error?: string }
    if (parsed.error) return parsed.error
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return body.trim() || `Request failed (${res.status})`
}

export function fetchSettings(): Promise<AppSettings> {
  return fetch("/api/settings", { cache: "no-store" }).then(json<AppSettings>)
}

/**
 * Where this machine keeps the app's JSON. Only the Data section shows it, and
 * only the settings *route* can read it at render time — the panel over the
 * chat has to ask.
 */
export function fetchDataDir(): Promise<string> {
  return fetch("/api/settings/data-dir", { cache: "no-store" })
    .then(json<{ dataDir: string }>)
    .then((data) => data.dataDir)
}

/**
 * Read-modify-write of the whole settings object — the file holds one blob,
 * and every writer in the app goes through the same serialized chain so two
 * of them cannot both read, then each overwrite the other's subtree.
 */
async function updateSettings(
  patch: (current: AppSettings) => AppSettings
): Promise<AppSettings> {
  await writeSettings(patch)
  return fetchSettings()
}

/** Pushes a folder to the front of the picker's MRU list. */
export function rememberFolder(path: string): Promise<AppSettings> {
  return updateSettings((current) => ({
    ...current,
    recentFolders: [
      path,
      ...current.recentFolders.filter((entry) => entry !== path),
    ].slice(0, MAX_RECENT_FOLDERS),
  }))
}

/** Drops a folder from the picker's MRU list. */
export function forgetFolder(path: string): Promise<AppSettings> {
  return updateSettings((current) => ({
    ...current,
    recentFolders: current.recentFolders.filter((entry) => entry !== path),
  }))
}

/**
 * Sub-directories of one folder, for the picker's browser. An empty path
 * lists the user's home; a half-typed one lists the nearest folder above it,
 * which the response names.
 */
export function fetchFolderListing(path: string): Promise<FolderListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ""
  return fetch(`/api/fs/list${query}`, { cache: "no-store" }).then(
    json<FolderListing>
  )
}

/** Does this path exist, is it a directory, and what git branches does it have. */
export function fetchFolderInfo(path: string): Promise<FolderInfo> {
  return fetch(`/api/fs/validate?path=${encodeURIComponent(path)}`, {
    cache: "no-store",
  }).then(json<FolderInfo>)
}

export function fetchProviders(): Promise<ProviderInfo[]> {
  return fetch("/api/providers", { cache: "no-store" })
    .then(json<{ providers: ProviderInfo[] }>)
    .then((data) => data.providers)
}

export type ConfigureBinaryResult =
  | { cancelled: true }
  | { path: string; providers: ProviderInfo[] }

/**
 * Windows-only: opens a native file dialog, saves the picked path as this
 * harness's binary, and returns the refreshed provider list.
 */
export function configureProviderBinary(
  providerId: string
): Promise<ConfigureBinaryResult> {
  return fetch("/api/providers/binary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId }),
  }).then(json<ConfigureBinaryResult>)
}

export type ModelsResponse = {
  providerId: string
  models: ModelOption[]
  capabilities?: ProviderCapabilities
  /** Model ids known to take image input — undefined when the provider can't tell. */
  visionModels?: string[]
  /**
   * Picker sections, in order, matching the `group` on each option — present
   * only for providers that serve models from more than one source.
   */
  groups?: ModelPickerGroup[]
  error?: string
}

export function fetchModels(providerId: string): Promise<ModelsResponse> {
  return fetch(`/api/models?provider=${encodeURIComponent(providerId)}`, {
    cache: "no-store",
  }).then(json<ModelsResponse>)
}

export type ModelProviderProbeResult = {
  ok: boolean
  count?: number
  error?: string
}

/**
 * Tests one `modelProviders` entry's `/models` endpoint server-side, so the
 * API key never has to round-trip through the browser. Always resolves —
 * `ok: false` carries the reason rather than a rejected promise.
 */
export function probeModelProvider(slug: string): Promise<ModelProviderProbeResult> {
  return fetch("/api/model-providers/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  }).then(json<ModelProviderProbeResult>)
}

export function fetchSessions(): Promise<SessionMeta[]> {
  return fetch("/api/sessions", { cache: "no-store" })
    .then(json<{ sessions: SessionMeta[] }>)
    .then((data) => data.sessions)
}

export function createSession(input: CreateSessionInput): Promise<SessionMeta> {
  return fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
    .then(json<{ session: SessionMeta }>)
    .then((data) => data.session)
}

export function patchSession(
  id: string,
  patch: SessionPatch
): Promise<SessionMeta> {
  return fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
    .then(json<{ session: SessionMeta }>)
    .then((data) => data.session)
}

export function deleteSession(id: string): Promise<void> {
  return fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }).then(async (res) => {
    if (!res.ok) throw new Error(await errorText(res))
  })
}

export function fetchMessages(id: string): Promise<StoredMessage[]> {
  return fetch(`/api/sessions/${encodeURIComponent(id)}`, { cache: "no-store" })
    .then(json<{ messages: StoredMessage[] }>)
    .then((data) => data.messages)
}

/** Persists an edited / pruned transcript (inline edits, deleted turns). */
export function putMessages(
  id: string,
  messages: StoredMessage[]
): Promise<void> {
  return fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  }).then(async (res) => {
    if (!res.ok) throw new Error(await errorText(res))
  })
}

export type FileResponse = {
  path: string
  content: string
  /** The file was over the route's cap — `content` is only its head. */
  truncated?: boolean
  /** The file's real size on disk, sent only when it was truncated. */
  bytes?: number
  /**
   * The file is not text. `content` is empty and the panel says so instead of
   * rendering a screenful of replacement characters — an outcome, not a
   * failure, which is why it resolves rather than rejects.
   */
  binary?: boolean
}

/**
 * One file's text, resolved against the provider's workspace. Only ever used
 * to enrich the preview panel, which already has the diff — callers are
 * expected to swallow the rejection.
 */
export async function fetchFile(
  path: string,
  providerId: string,
  sessionId = ""
): Promise<FileResponse> {
  const query = new URLSearchParams({ path, provider: providerId })
  // The chat's own folder, when it has one — resolved server-side from the
  // stored session, so this is a name, not a root the client gets to pick.
  if (sessionId) query.set("session", sessionId)
  const response = await fetch(`/api/file?${query}`, { cache: "no-store" })
  if (response.status === 415) {
    const body = (await response.json().catch(() => null)) as {
      path?: string
      binary?: boolean
    } | null
    if (body?.binary) {
      return { path: body.path || path, content: "", binary: true }
    }
  }
  return json<FileResponse>(response)
}

/**
 * One directory *inside* the chat's folder, for the file panel's folder
 * browser — files included, one level at a time. Not to be confused with
 * `fetchFolderListing`, which browses the machine for a folder to point a chat
 * at and answers with directories alone.
 */
export function listFolderLevel(
  sessionId: string,
  dir: string,
  signal?: AbortSignal
): Promise<{ entries: { path: string }[]; truncated?: boolean }> {
  const params = new URLSearchParams({ sessionId, dir })
  return fetch(`/api/fs/tree?${params}`, { cache: "no-store", signal }).then(
    json<{ entries: { path: string }[]; truncated?: boolean }>
  )
}

export type ChatRequest = {
  prompt: string
  providerId: string
  model: string
  /** App session id — the thread being appended to. */
  sessionId: string
  effort?: string
  /**
   * How much the harness may touch for this turn — only meaningful for
   * providers whose `capabilities.permissionModes` lists it; the route drops
   * anything else.
   */
  permissionMode?: PermissionMode
  /** Minted here so optimistic rows and persisted rows share their ids. */
  userMessageId: string
  assistantMessageId: string
  /** Images the composer resolved as vision-eligible for this turn. */
  attachments?: MessageAttachmentData[]
  /**
   * Exactly what the user typed, before the skill prefix, the attachment
   * fences and the "Attached: …" note the composer adds. The memory extractor
   * is fed this instead of `content`, so a file the turn merely carried cannot
   * write itself into every future prompt. Absent when it is not known — a
   * regenerate re-runs a stored message, whose typed half is long gone.
   */
  typedText?: string
}

/** Streams `POST /api/chat`, handing every SSE event to `onEvent`. */
export async function streamChat(
  body: ChatRequest,
  handlers: {
    onEvent: (event: AgentStreamEvent) => void
    /**
     * The chat route's own frame, sent once the turn has settled: the handoff
     * the turn was given and the per-agent sessions the chat now holds. It is
     * not part of the vendored stream protocol, so it is peeled off here
     * rather than folded into the message reducer.
     */
    onTurnState?: (state: TurnStateFrame) => void
    signal: AbortSignal
  }
) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: handlers.signal,
  })

  if (!res.ok || !res.body) throw new Error(await errorText(res))

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const lines = new LineBuffer()
  let eventLines: string[] = []

  const consume = (rawLines: string[]) => {
    for (const raw of rawLines) {
      const line = raw.replace(/\r$/, "")
      if (line) {
        eventLines.push(line)
        continue
      }
      const data = eventLines
        .filter((entry) => entry.startsWith("data:"))
        .map((entry) => entry.slice(5).trimStart())
        .join("\n")
        .trim()
      eventLines = []
      if (!data || data === "[DONE]") continue
      const frame = JSON.parse(data) as AgentStreamEvent | TurnStateFrame
      if (frame.type === "turn-state") {
        handlers.onTurnState?.(frame)
        continue
      }
      handlers.onEvent(frame)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    consume(lines.push(decoder.decode(value, { stream: true })))
  }
  consume(lines.push(decoder.decode()))
  const tail = lines.finish()
  if (tail !== null) consume([tail, ""])
}

/**
 * Answers a request a *running* turn is blocked on — an ACP permission prompt,
 * say. It is a second POST on purpose: the turn's own response is an SSE
 * stream the browser is still reading, and the outcome comes back down it as
 * another tool event rather than in this reply.
 *
 * A 404 means nothing was waiting any more (the turn was stopped, or another
 * tab answered first), which callers surface rather than retry.
 */
export function respondToRequest(
  sessionId: string,
  requestId: string,
  answer: UserRequestAnswer
): Promise<void> {
  return fetch("/api/chat/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, requestId, answer }),
  }).then(async (res) => {
    if (!res.ok) throw new Error(await errorText(res))
  })
}

/* -------------------------------------------------------------------------- */
/* Memory                                                                      */
/* -------------------------------------------------------------------------- */

export type MemoryStore = {
  /** Absolute path of the memory directory, shown in settings. */
  dir: string
  files: MemoryFile[]
  bytes: number
  /** Ollama's state, which the settings page cannot know without asking. */
  ollamaEnabled: boolean
  ollamaBaseUrl: string
  ollamaReachable: boolean
}

export function fetchMemory(): Promise<MemoryStore> {
  return fetch("/api/memory", { cache: "no-store" }).then(json<MemoryStore>)
}

type MemoryWriteResult = { files: MemoryFile[]; bytes: number }

/** Saves one category from the settings editor; empty content deletes it. */
export function putMemoryFile(
  category: string,
  content: string
): Promise<MemoryWriteResult> {
  return fetch("/api/memory", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, content }),
  }).then(json<MemoryWriteResult>)
}

/** Drops one category, or the whole store when `category` is omitted. */
export function deleteMemoryFile(category?: string): Promise<MemoryWriteResult> {
  const query = category ? `?category=${encodeURIComponent(category)}` : ""
  return fetch(`/api/memory${query}`, { method: "DELETE" }).then(
    json<MemoryWriteResult>
  )
}

/**
 * Runs an extraction pass over a thread. Fires after a turn settles, on its
 * own request, so nothing about it can delay or fail the answer itself.
 */
export function updateMemory(sessionId: string): Promise<MemoryUpdateResult> {
  return fetch("/api/memory/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }).then(json<MemoryUpdateResult>)
}

/* -------------------------------------------------------------------------- */
/* Open in editor / reveal / terminal                                          */
/* -------------------------------------------------------------------------- */

export type OpenTarget = { id: string; name: string }

export type OpenTargets = {
  platform: string
  editors: OpenTarget[]
  terminals: OpenTarget[]
}

/** The editors and terminals installed on the machine the server runs on. */
export function fetchOpenTargets(): Promise<OpenTargets> {
  return fetch("/api/open", { cache: "no-store" }).then(json<OpenTargets>)
}

export type OpenRequest = {
  action: "editor" | "reveal" | "terminal"
  /** Absolute, or relative to the chat's folder when `sessionId` is given. */
  path: string
  line?: number
  editor?: string
  terminal?: string
  sessionId?: string
}

/** Opens a path in an editor or terminal, or reveals it in the file manager. */
export function openPath(
  request: OpenRequest
): Promise<{ ok: true; target?: OpenTarget }> {
  return fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }).then(json<{ ok: true; target?: OpenTarget }>)
}

/* -------------------------------------------------------------------------- */
/* Files and git                                                               */
/* -------------------------------------------------------------------------- */

/** Files under the chat's folder matching `query`, for the `@` menu. */
export function searchFiles(
  sessionId: string,
  query: string,
  signal?: AbortSignal
): Promise<{ files: string[]; truncated: boolean }> {
  const params = new URLSearchParams({ session: sessionId, q: query })
  return fetch(`/api/fs/search?${params}`, { cache: "no-store", signal }).then(
    json<{ files: string[]; truncated: boolean }>
  )
}

import type { GitStatus } from "@/lib/git-status"
export type { GitStatus }

/** The git state of a chat's folder, resolved server-side from the chat. */
export function fetchGitStatus(sessionId: string): Promise<GitStatus> {
  return fetch(`/api/git/status?session=${encodeURIComponent(sessionId)}`, {
    cache: "no-store",
  }).then(json<GitStatus>)
}

/** `git checkout -- <path>` inside the chat's folder. */
export function revertFile(
  sessionId: string,
  path: string
): Promise<{ ok: true; path: string }> {
  return fetch("/api/git/revert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, path }),
  }).then(json<{ ok: true; path: string }>)
}

import type { SkillCatalog } from "@/lib/skills"

/**
 * The skills and provider commands available in a chat's folder, scanned
 * server-side (`app/api/skills`). The chat names itself; the server decides
 * which folder that is.
 */
export function fetchSkills(sessionId: string): Promise<SkillCatalog> {
  return fetch(`/api/skills?sessionId=${encodeURIComponent(sessionId)}`, {
    cache: "no-store",
  }).then(json<SkillCatalog>)
}

/** Asks a model to name the chat, and stores the answer. */
export function regenerateTitle(
  sessionId: string
): Promise<{ session: SessionMeta; title: string }> {
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
    method: "POST",
  }).then(json<{ session: SessionMeta; title: string }>)
}

/**
 * Tokens and estimated cost across every stored chat, aggregated server-side
 * (`app/api/usage`). `days` of `"all"` drops the window.
 */
export function fetchUsage(days: number | "all"): Promise<UsageReport> {
  return fetch(`/api/usage?days=${days}`, { cache: "no-store" }).then(
    json<UsageReport>
  )
}

/**
 * Chats whose *messages* match `query`, ranked and snippeted server-side
 * (`app/api/search`) for the command palette's Messages group. Aborted and
 * re-issued on every keystroke, so the signal is the point.
 */
export function searchChatMessages(
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<MessageSearchResult> {
  const params = new URLSearchParams({ q: query })
  if (options.limit) params.set("limit", String(options.limit))
  return fetch(`/api/search?${params}`, {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : null),
  }).then(json<MessageSearchResult>)
}

/* -------------------------------------------------------------------------- */
/* Importing a CLI's own history                                               */
/* -------------------------------------------------------------------------- */

import type {
  ImportProvider,
  ImportRequest,
  ImportResult,
  ImportScanResult,
} from "@/lib/import/types"
export type { ImportProvider, ImportRequest, ImportResult, ImportScanResult }

/**
 * Every folder Claude Code or Codex has run in on this machine. The scan reads
 * those CLIs' transcript directories, so it is slower than the app's own
 * routes — the import dialog runs it once, when it opens.
 */
export function scanImports(signal?: AbortSignal): Promise<ImportScanResult> {
  return fetch("/api/import/scan", { cache: "no-store", signal }).then(
    json<ImportScanResult>
  )
}

/** Imports the named folders' conversations; already-imported ones are skipped. */
export function runImport(request: ImportRequest): Promise<ImportResult> {
  return fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }).then(json<ImportResult>)
}

/** Chat id → the CLI it was imported from, for the sidebar's badge. */
export function fetchImportedSessions(): Promise<
  Record<string, ImportProvider>
> {
  return fetch("/api/import/imported", { cache: "no-store" })
    .then(json<{ sessions: Record<string, ImportProvider> }>)
    .then((body) => body.sessions)
}

/* -------------------------------------------------------------------------- */
/* Worktrees                                                                   */
/* -------------------------------------------------------------------------- */

import type { WorktreeEntry, WorktreeStatus } from "@/lib/worktree"
export type { WorktreeEntry, WorktreeStatus }

/**
 * A new worktree of `repoRoot`, on a new branch, under the app's own data
 * directory. The folder it answers with is what the chat's `cwd` becomes.
 *
 * `title` only names the branch when `branch` is not given.
 */
export function createWorktree(input: {
  repoRoot: string
  title?: string
  branch?: string
  baseRef?: string
}): Promise<SessionWorktree> {
  return fetch("/api/worktrees", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then(json<SessionWorktree>)
}

/** Every worktree a repository has registered, the stale ones already dropped. */
export function fetchWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const params = new URLSearchParams({ repoRoot })
  return fetch(`/api/worktrees?${params}`, { cache: "no-store" })
    .then(json<{ worktrees: WorktreeEntry[] }>)
    .then((data) => data.worktrees)
}

/**
 * Whether a folder is a worktree this app made, and what removing it would
 * throw away. `managed: false` means there is nothing to offer.
 */
export type WorktreeCleanup =
  | { managed: false; root: string }
  | {
      managed: true
      root: string
      repoRoot: string
      branch?: string
      status: WorktreeStatus
    }

export function fetchWorktreeCleanup(root: string): Promise<WorktreeCleanup> {
  const params = new URLSearchParams({ root })
  return fetch(`/api/worktrees/status?${params}`, { cache: "no-store" }).then(
    json<WorktreeCleanup>
  )
}

/** Removes a worktree and, when named, the branch it had checked out. */
export function removeWorktree(input: {
  repoRoot: string
  root: string
  branch?: string
  force?: boolean
}): Promise<{ ok: true; removed: boolean; branchDeleted: boolean }> {
  return fetch("/api/worktrees", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then(json<{ ok: true; removed: boolean; branchDeleted: boolean }>)
}

/* -------------------------------------------------------------------------- */
/* Commit, push, dev servers                                                   */
/* -------------------------------------------------------------------------- */

import type { CommitStyle } from "@/lib/git-commit"
import type { DevServer } from "@/lib/dev-servers"
export type { CommitStyle, DevServer }

export type CommitRequest = {
  sessionId: string
  /** The files to commit; everything the tree has changed when omitted. */
  paths?: string[]
  /** The user's own message. Omitted, one is written from the staged diff. */
  message?: string
  style?: CommitStyle
  /** Sent on the second call, after the default-branch question was answered. */
  allowDefaultBranch?: boolean
}

/**
 * Committing the chat's changes.
 *
 * `needsConfirmation` is not an error and does not throw: the branch is the
 * repository's trunk, and the UI is expected to ask before calling again with
 * `allowDefaultBranch: true` — passing back the `message` it was handed, so
 * the commit that lands is the one the user was shown.
 */
export type CommitResponse =
  | { ok: true; sha: string; message: string; subject: string }
  | {
      needsConfirmation: "default-branch"
      branch?: string
      message: string
      subject: string
    }

export function commitChanges(request: CommitRequest): Promise<CommitResponse> {
  return fetch("/api/git/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }).then(json<CommitResponse>)
}

/** Pushes the chat folder's branch, setting its upstream on the first push. */
export function pushChanges(
  sessionId: string
): Promise<{ ok: true; branch: string; created: boolean }> {
  return fetch("/api/git/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }).then(json<{ ok: true; branch: string; created: boolean }>)
}

/**
 * Local ports currently serving a page. Scoped to the chat's folder when a
 * session is named and the platform can attribute a listener to a directory.
 */
export function fetchDevServers(sessionId?: string): Promise<DevServer[]> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""
  return fetch(`/api/dev-servers${query}`, { cache: "no-store" })
    .then(json<{ servers: DevServer[] }>)
    .then((data) => data.servers)
}
