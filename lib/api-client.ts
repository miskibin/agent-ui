import type { MessageAttachmentData } from "@/components/ui/message"
import type { ModelOption } from "@/components/ui/model-picker"
import type { FolderInfo, FolderListing } from "@/lib/folder"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import type { ProviderCapabilities, ProviderInfo } from "@/lib/providers/types"
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
  error?: string
}

export function fetchModels(providerId: string): Promise<ModelsResponse> {
  return fetch(`/api/models?provider=${encodeURIComponent(providerId)}`, {
    cache: "no-store",
  }).then(json<ModelsResponse>)
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

export type ChatRequest = {
  prompt: string
  providerId: string
  model: string
  /** App session id — the thread being appended to. */
  sessionId: string
  effort?: string
  /** Minted here so optimistic rows and persisted rows share their ids. */
  userMessageId: string
  assistantMessageId: string
  /** Images the composer resolved as vision-eligible for this turn. */
  attachments?: MessageAttachmentData[]
}

/** Streams `POST /api/chat`, handing every SSE event to `onEvent`. */
export async function streamChat(
  body: ChatRequest,
  handlers: { onEvent: (event: AgentStreamEvent) => void; signal: AbortSignal }
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
      handlers.onEvent(JSON.parse(data) as AgentStreamEvent)
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
