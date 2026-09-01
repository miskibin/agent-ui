import type { ModelOption } from "@/components/ui/model-picker"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import type { ProviderCapabilities, ProviderInfo } from "@/lib/providers/types"
import type { AppSettings } from "@/lib/settings/schema"
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

export function fetchProviders(): Promise<ProviderInfo[]> {
  return fetch("/api/providers", { cache: "no-store" })
    .then(json<{ providers: ProviderInfo[] }>)
    .then((data) => data.providers)
}

export type ModelsResponse = {
  providerId: string
  models: ModelOption[]
  capabilities?: ProviderCapabilities
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
  providerId: string
): Promise<FileResponse> {
  const query = new URLSearchParams({ path, provider: providerId })
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
  /** Minted here so optimistic rows and persisted rows share their ids. */
  userMessageId: string
  assistantMessageId: string
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
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split("\n\n")
    buffer = chunks.pop() ?? ""
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((entry) => entry.startsWith("data: "))
      if (!line) continue
      const data = line.slice(6).trim()
      if (!data || data === "[DONE]") continue
      handlers.onEvent(JSON.parse(data) as AgentStreamEvent)
    }
  }
}
