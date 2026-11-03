/**
 * The page's side of `/api/notes`. Plain fetches, like `lib/api-client`, kept
 * here so the notes feature stays in one folder.
 */

import type {
  NoteDoc,
  NoteEvent,
  NoteHistoryEntry,
  NoteMeta,
  NoteThread,
} from "@/lib/notes/types"

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    let message = body || `Request failed (${res.status})`
    try {
      const parsed = JSON.parse(body) as { error?: string }
      if (parsed.error) message = parsed.error
    } catch {
      /* not JSON */
    }
    throw new Error(message)
  }
  return (await res.json()) as T
}

const JSON_HEADERS = { "Content-Type": "application/json" }

export function fetchNotes(): Promise<NoteMeta[]> {
  return fetch("/api/notes", { cache: "no-store" })
    .then(json<{ notes: NoteMeta[] }>)
    .then((data) => data.notes)
}

export function createNote(content = ""): Promise<NoteDoc> {
  return fetch("/api/notes", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ content }),
  }).then(json<NoteDoc>)
}

export type NoteSnapshot = NoteDoc & { threads: NoteThread[]; activeThread: string | null }

export function fetchNote(id: string, signal?: AbortSignal): Promise<NoteSnapshot> {
  return fetch(`/api/notes/${id}`, { cache: "no-store", signal }).then(json<NoteSnapshot>)
}

export function fetchNoteThreads(id: string): Promise<{ threads: NoteThread[]; activeThread: string | null }> {
  return fetch(`/api/notes/${id}?part=threads`, { cache: "no-store" }).then(
    json<{ threads: NoteThread[]; activeThread: string | null }>
  )
}

export function saveNote(
  id: string,
  input: { content: string; baseRev: number; base: string }
): Promise<NoteDoc & { merged: boolean }> {
  return fetch(`/api/notes/${id}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  }).then(json<NoteDoc & { merged: boolean }>)
}

export function deleteNote(id: string): Promise<void> {
  return fetch(`/api/notes/${id}`, { method: "DELETE" }).then(json<unknown>).then(() => undefined)
}

export function askNote(
  id: string,
  input: {
    threadId?: string
    anchor?: string
    instruction: string
    providerId: string
    model: string
  }
): Promise<{ threadId: string }> {
  return fetch(`/api/notes/${id}/ask`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  }).then(json<{ threadId: string }>)
}

export function cancelNoteAsk(id: string, threadId: string): Promise<void> {
  return fetch(`/api/notes/${id}/ask?thread=${encodeURIComponent(threadId)}`, { method: "DELETE" })
    .then(json<unknown>)
    .then(() => undefined)
}

export function resolveThread(id: string, threadId: string, resolved: boolean): Promise<void> {
  return fetch(`/api/notes/${id}/threads`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ threadId, resolved }),
  })
    .then(json<unknown>)
    .then(() => undefined)
}

export function deleteThread(id: string, threadId: string): Promise<void> {
  return fetch(`/api/notes/${id}/threads?thread=${encodeURIComponent(threadId)}`, { method: "DELETE" })
    .then(json<unknown>)
    .then(() => undefined)
}

export function fetchNoteHistory(id: string): Promise<NoteHistoryEntry[]> {
  return fetch(`/api/notes/${id}/history`, { cache: "no-store" })
    .then(json<{ history: NoteHistoryEntry[] }>)
    .then((data) => data.history)
}

export function restoreNote(id: string, rev: number): Promise<NoteDoc> {
  return fetch(`/api/notes/${id}/history`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ rev }),
  }).then(json<NoteDoc>)
}

export async function uploadNoteImage(file: File): Promise<string> {
  const form = new FormData()
  form.set("file", file)
  const { src } = await fetch("/api/notes/assets", { method: "POST", body: form }).then(json<{ src: string }>)
  return src
}

/** An `assets/<name>` path from a note, as a URL the page can load. */
export function noteImageUrl(src: string) {
  const match = /^(?:\.\/)?assets\/([^/?#]+)$/.exec(src)
  return match ? `/api/notes/assets/${match[1]}` : src
}

/** Follows a note's writers; returns the unsubscribe. Reconnects on its own. */
export function watchNote(id: string, onEvent: (event: NoteEvent) => void) {
  const source = new EventSource(`/api/notes/${id}/events`)
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as NoteEvent)
    } catch {
      /* a frame we do not understand */
    }
  }
  return () => source.close()
}
