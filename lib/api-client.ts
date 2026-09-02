import type { MessageAttachmentData } from "@/components/ui/message"
import type { ModelOption, ModelPickerGroup } from "@/components/ui/model-picker"
import type { FolderInfo, FolderListing } from "@/lib/folder"
import type { TurnStateFrame } from "@/lib/handoff/types"
import type { MemoryFile, MemoryUpdateResult } from "@/lib/memory/types"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import type {
  PermissionMode,
  ProviderCapabilities,
  ProviderInfo,
} from "@/lib/providers/types"
import { MAX_RECENT_FOLDERS, type AppSettings } from "@/lib/settings/schema"
import { LineBuffer } from "@/lib/stream-framing"
import type {
  CreateSessionInput,
  SessionMeta,
  SessionPatch,
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

/** Read-modify-write of the whole settings object — the file holds one blob. */
async function updateSettings(
  patch: (current: AppSettings) => AppSettings
): Promise<AppSettings> {
  const current = await fetchSettings()
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch(current)),
  })
  return json<AppSettings>(res)
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
}

/**
 * One file's text, resolved against the provider's workspace. Only ever used
 * to enrich the preview panel, which already has the diff — callers are
 * expected to swallow the rejection.
 */
export function fetchFile(
  path: string,
  providerId: string,
  sessionId = ""
): Promise<FileResponse> {
  const query = new URLSearchParams({ path, provider: providerId })
  // The chat's own folder, when it has one — resolved server-side from the
  // stored session, so this is a name, not a root the client gets to pick.
  if (sessionId) query.set("session", sessionId)
  return fetch(`/api/file?${query}`, { cache: "no-store" }).then(
    json<FileResponse>
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

export type GitStatus = {
  isGitRepo: boolean
  branch: string
  ahead: number
  behind: number
  dirty: number
  pr?: {
    number: number
    url: string
    state: "OPEN" | "MERGED" | "CLOSED"
    title: string
  }
}

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

/** Asks a model to name the chat, and stores the answer. */
export function regenerateTitle(
  sessionId: string
): Promise<{ session: SessionMeta; title: string }> {
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
    method: "POST",
  }).then(json<{ session: SessionMeta; title: string }>)
}
