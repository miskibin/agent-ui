import "server-only"

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { dataDir } from "@/lib/settings/server"
import { migrateAgentSessions } from "@/lib/handoff/cursor"
import { appendEvents, normalizeJournal } from "@/lib/handoff/journal"
import type { JournalEvent, NewJournalEvent } from "@/lib/handoff/types"
import type {
  CreateSessionInput,
  SessionMeta,
  SessionPatch,
  StoredMessage,
} from "@/lib/store/types"

/**
 * A tiny JSON store under `~/.agent-ui` (or `$AGENT_UI_DIR`).
 *
 *   sessions/index.json        — every thread's metadata, in sidebar order
 *   sessions/<id>.json         — one thread's messages
 *   sessions/<id>.journal.json — one thread's semantic event journal
 *
 * Metadata is deliberately split from message bodies: the sidebar, the chat
 * route and the settings page only ever read the small index, and a thread's
 * messages are loaded lazily when it is opened. Writes go to a temp file and
 * are renamed into place, and every write — index, transcript and journal
 * alike — runs through one one-slot queue, so concurrent requests cannot
 * interleave a read-modify-write and the delete that removes all three files
 * cannot land in the middle of a turn writing them.
 */

const MAX_TITLE = 120

function sessionsDir() {
  return join(dataDir(), "sessions")
}

function indexPath() {
  return join(sessionsDir(), "index.json")
}

function messagesPath(id: string) {
  return join(sessionsDir(), `${id}.json`)
}

/**
 * The journal is its own file, not a key in the index and not a field on the
 * transcript: the sidebar reads the index on every page load and must not
 * carry an agent's tool history, and a chat's messages are rewritten on every
 * streamed turn while the journal is only ever appended to.
 */
function journalPath(id: string) {
  return join(sessionsDir(), `${id}.journal.json`)
}

/** Ids end up in a file path — keep them to a known-safe alphabet. */
export function isValidSessionId(id: string) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

export function newSessionId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(sessionsDir(), { recursive: true })
  const tmp = `${path}.${process.pid.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(value), "utf8")
  await rename(tmp, path)
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return fallback
  }
}

/* -------------------------------------------------------------------------- */
/* Index                                                                       */
/* -------------------------------------------------------------------------- */

let queue: Promise<unknown> = Promise.resolve()
let indexCache: SessionMeta[] | null = null

/**
 * Serializes every store read-modify-write in this process. One queue rather
 * than one per file: a turn writes the transcript, the index and the journal
 * for the same chat, and `deleteSession` removes all three — the only ordering
 * that is safe is "no two of those at once".
 */
function withStoreLock<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

function normalizeMeta(raw: unknown, fallbackOrder: number): SessionMeta | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  const id = typeof value.id === "string" ? value.id : ""
  if (!isValidSessionId(id)) return null
  const now = Date.now()
  const agentSessions = migrateAgentSessions(value.agentSessions, {
    providerId: typeof value.providerId === "string" ? value.providerId : "",
    providerSessionId:
      typeof value.providerSessionId === "string" ? value.providerSessionId : "",
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : null),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
  })
  return {
    id,
    title: typeof value.title === "string" ? value.title : "New chat",
    pinned: value.pinned === true,
    order: typeof value.order === "number" ? value.order : fallbackOrder,
    providerId: typeof value.providerId === "string" ? value.providerId : "",
    model: typeof value.model === "string" ? value.model : "",
    providerSessionId:
      typeof value.providerSessionId === "string"
        ? value.providerSessionId
        : undefined,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    gitBranch:
      typeof value.gitBranch === "string" ? value.gitBranch : undefined,
    permissionMode:
      typeof value.permissionMode === "string"
        ? value.permissionMode
        : undefined,
    ...(agentSessions ? { agentSessions } : null),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
    messageCount:
      typeof value.messageCount === "number" ? value.messageCount : 0,
  }
}

/**
 * Applies the metadata half of a patch. `order` is not here: it moves the row
 * within the index, which only `patchSession` does.
 */
function applyPatch(meta: SessionMeta, patch: SessionPatch): SessionMeta {
  return {
    ...meta,
    ...(patch.title !== undefined ? { title: clampTitle(patch.title) } : null),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : null),
    ...(patch.providerId !== undefined
      ? { providerId: patch.providerId }
      : null),
    ...(patch.model !== undefined ? { model: patch.model } : null),
    ...(patch.providerSessionId !== undefined
      ? { providerSessionId: patch.providerSessionId }
      : null),
    ...(patch.agentSessions !== undefined
      ? { agentSessions: patch.agentSessions }
      : null),
    ...(patch.cwd !== undefined ? { cwd: patch.cwd.trim() } : null),
    ...(patch.gitBranch !== undefined
      ? { gitBranch: patch.gitBranch.trim() }
      : null),
    ...(patch.permissionMode !== undefined
      ? { permissionMode: patch.permissionMode.trim() }
      : null),
    updatedAt: Date.now(),
  }
}

/** Renumbers `order` to the array position so it stays dense and sortable. */
function reindex(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.map((session, order) => ({ ...session, order }))
}

async function readIndex(): Promise<SessionMeta[]> {
  if (indexCache) return indexCache
  const raw = await readJson<unknown[]>(indexPath(), [])
  if (!Array.isArray(raw)) {
    indexCache = []
    return indexCache
  }
  indexCache = raw
    .map((entry, index) => normalizeMeta(entry, index))
    .filter((entry): entry is SessionMeta => entry !== null)
    .sort((a, b) => a.order - b.order)
  return indexCache
}

async function writeIndex(sessions: SessionMeta[]) {
  await writeJsonAtomic(indexPath(), sessions)
  indexCache = sessions
}

export function listSessions(): Promise<SessionMeta[]> {
  return readIndex()
}

export function getSession(id: string): Promise<SessionMeta | null> {
  if (!isValidSessionId(id)) return Promise.resolve(null)
  return readIndex().then(
    (sessions) => sessions.find((session) => session.id === id) ?? null
  )
}

export function createSession(input: CreateSessionInput): Promise<SessionMeta> {
  return withStoreLock(async () => {
    const now = Date.now()
    const session: SessionMeta = {
      id: newSessionId(),
      title: clampTitle(input.title) || "New chat",
      pinned: false,
      order: 0,
      providerId: input.providerId ?? "",
      model: input.model ?? "",
      ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : null),
      ...(input.gitBranch?.trim() ? { gitBranch: input.gitBranch.trim() } : null),
      ...(input.permissionMode?.trim()
        ? { permissionMode: input.permissionMode.trim() }
        : null),
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    }
    const sessions = await readIndex()
    await writeIndex(reindex([session, ...sessions]))
    return session
  })
}

/**
 * Patches one session's metadata. `order` moves the row to that index and the
 * whole list is renumbered, which is what the sidebar's drag-to-reorder and
 * pin-to-top gestures send.
 */
export function patchSession(
  id: string,
  patch: SessionPatch
): Promise<SessionMeta | null> {
  return withStoreLock(async () => {
    const sessions = await readIndex()
    const index = sessions.findIndex((session) => session.id === id)
    if (index < 0) return null

    const next = applyPatch(sessions[index], patch)

    const rest = [...sessions.slice(0, index), ...sessions.slice(index + 1)]
    const target =
      patch.order === undefined
        ? index
        : Math.min(Math.max(Math.trunc(patch.order), 0), rest.length)
    rest.splice(target, 0, next)
    await writeIndex(reindex(rest))
    return next
  })
}

export function deleteSession(id: string): Promise<boolean> {
  return withStoreLock(async () => {
    const sessions = await readIndex()
    if (!sessions.some((session) => session.id === id)) return false
    await writeIndex(reindex(sessions.filter((session) => session.id !== id)))
    await rm(messagesPath(id), { force: true })
    await rm(journalPath(id), { force: true })
    return true
  })
}

/** Wipes every thread — the Data section of the settings page calls this. */
export function clearSessions(): Promise<number> {
  return withStoreLock(async () => {
    const sessions = await readIndex()
    await writeIndex([])
    await Promise.all(
      sessions.flatMap((session) => [
        rm(messagesPath(session.id), { force: true }),
        rm(journalPath(session.id), { force: true }),
      ])
    )
    return sessions.length
  })
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export async function readMessages(id: string): Promise<StoredMessage[]> {
  if (!isValidSessionId(id)) return []
  const raw = await readJson<StoredMessage[]>(messagesPath(id), [])
  return Array.isArray(raw) ? raw : []
}

/** Replaces the thread and keeps `messageCount` / `updatedAt` in step. */
export function writeMessages(
  id: string,
  messages: StoredMessage[],
  patch: SessionPatch = {}
): Promise<SessionMeta | null> {
  return commitMessages(id, () => messages, patch)
}

/**
 * Merges rows into the stored thread by id: a message the file does not have
 * is appended, one it has is replaced where it stands.
 *
 * This is how a streaming turn persists, and the difference matters. A turn
 * starts by reading the transcript and ends minutes later; writing back the
 * array it started from would quietly undo everything that happened in
 * between — an edited earlier message, a deleted turn, a message the user sent
 * to another agent in the same chat. Only the two rows the turn actually owns
 * are its to write.
 */
export function upsertMessages(
  id: string,
  messages: StoredMessage[],
  patch: SessionPatch = {}
): Promise<SessionMeta | null> {
  return commitMessages(
    id,
    (current) => {
      const next = [...current]
      for (const message of messages) {
        const at = next.findIndex((entry) => entry.id === message.id)
        if (at < 0) next.push(message)
        else next[at] = message
      }
      return next
    },
    patch
  )
}

/**
 * The transcript write, under the store lock and gated on the index.
 *
 * A chat deleted while its turn was still streaming must stay deleted: the
 * index is the record of what exists, so a write for a chat that is no longer
 * in it writes nothing rather than re-creating `sessions/<id>.json` as an
 * orphan nothing will ever clean up.
 */
function commitMessages(
  id: string,
  resolve: (current: StoredMessage[]) => StoredMessage[],
  patch: SessionPatch
): Promise<SessionMeta | null> {
  if (!isValidSessionId(id)) return Promise.resolve(null)
  return withStoreLock(async () => {
    const sessions = await readIndex()
    const index = sessions.findIndex((session) => session.id === id)
    if (index < 0) return null
    const messages = resolve(await readMessages(id))
    await writeJsonAtomic(messagesPath(id), messages)
    const next: SessionMeta = {
      ...applyPatch(sessions[index], patch),
      messageCount: messages.length,
    }
    sessions[index] = next
    await writeIndex(sessions)
    return next
  })
}

/* -------------------------------------------------------------------------- */
/* Journal                                                                     */
/* -------------------------------------------------------------------------- */

export async function readJournal(id: string): Promise<JournalEvent[]> {
  if (!isValidSessionId(id)) return []
  return normalizeJournal(await readJson<unknown>(journalPath(id), []))
}

/**
 * Appends a turn's events and returns the journal as it now stands. Seqs are
 * only ever handed out here, so they stay monotonic per chat even when the
 * cap drops the front of the file.
 *
 * Under the store lock and gated on the index for the same reason the
 * transcript is: the journal of a chat that was deleted mid-turn must not be
 * written back after `deleteSession` removed it.
 */
export function appendJournal(
  id: string,
  events: NewJournalEvent[]
): Promise<JournalEvent[]> {
  if (!isValidSessionId(id) || events.length === 0) return readJournal(id)
  return withStoreLock(async () => {
    const sessions = await readIndex()
    if (!sessions.some((session) => session.id === id)) return []
    const existing = normalizeJournal(
      await readJson<unknown>(journalPath(id), [])
    )
    const next = appendEvents(existing, events)
    await writeJsonAtomic(journalPath(id), next)
    return next
  })
}

function clampTitle(title?: string) {
  return (title ?? "").trim().slice(0, MAX_TITLE)
}
