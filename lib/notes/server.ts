import "server-only"

import { createHash, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"

import { writeFileAtomic } from "@/lib/atomic-write"
import {
  applyNoteOps,
  mergeNotes,
  noteTitle,
  stripPending,
  type NoteOp,
  type NoteOpsResult,
} from "@/lib/notes/blocks"
import {
  isValidNoteId,
  UNTITLED_NOTE,
  type NoteAuthor,
  type NoteDoc,
  type NoteEvent,
  type NoteHistoryEntry,
  type NoteMeta,
  type NoteThread,
} from "@/lib/notes/types"
import { dataDir } from "@/lib/settings/server"

/**
 * The notes vault: `$AGENT_UI_DIR/notes`, owned by the app rather than by any
 * project. Each note is `<id>.md` — a plain file the person can open in any
 * editor — with `index.json` beside them for the sidebar, `<id>.threads.json`
 * for its threads, `history/<id>.json` for the revisions it can go back to,
 * and `assets/` for the images pasted into any of them.
 *
 * Two writers share a note, the person typing and an agent editing, so every
 * write to one note goes through one lock, every write bumps `rev`, and a
 * save that started from an older rev is merged block by block instead of
 * winning (`mergeNotes`).
 */

type State = {
  index?: NoteMeta[]
  locks: Map<string, Promise<unknown>>
  bus: EventEmitter
}

const globalState = globalThis as typeof globalThis & { __agentUiNotes?: State }
const state: State = (globalState.__agentUiNotes ??= {
  locks: new Map(),
  bus: new EventEmitter().setMaxListeners(0),
})

/** History kept per note — enough to step back through an afternoon. */
const MAX_HISTORY = 60
/** A run of the person's own saves is one revision until it pauses this long. */
const HISTORY_COALESCE_MS = 2 * 60_000
export const MAX_NOTE_CHARS = 2_000_000
export const MAX_ASSET_BYTES = 20 * 1024 * 1024

export function notesDir() {
  return join(/*turbopackIgnore: true*/ dataDir(), "notes")
}

function indexPath() {
  return join(/*turbopackIgnore: true*/ notesDir(), "index.json")
}

function notePath(id: string) {
  return join(/*turbopackIgnore: true*/ notesDir(), `${id}.md`)
}

function threadsPath(id: string) {
  return join(/*turbopackIgnore: true*/ notesDir(), `${id}.threads.json`)
}

function historyPath(id: string) {
  return join(/*turbopackIgnore: true*/ notesDir(), "history", `${id}.json`)
}

export function assetsDir() {
  return join(/*turbopackIgnore: true*/ notesDir(), "assets")
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return fallback
  }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(join(/*turbopackIgnore: true*/ path, ".."), { recursive: true })
  await writeFileAtomic(path, JSON.stringify(value))
}

function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = state.locks.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  const settled = next.catch(() => undefined)
  state.locks.set(key, settled)
  void settled.then(() => {
    if (state.locks.get(key) === settled) state.locks.delete(key)
  })
  return next
}

function normalizeMeta(raw: unknown): NoteMeta | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  const id = typeof value.id === "string" ? value.id : ""
  if (!isValidNoteId(id)) return null
  const now = Date.now()
  return {
    id,
    title: typeof value.title === "string" && value.title ? value.title : UNTITLED_NOTE,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
    rev: typeof value.rev === "number" ? value.rev : 0,
    ...(typeof value.chatId === "string" ? { chatId: value.chatId } : null),
    ...(typeof value.providerId === "string" ? { providerId: value.providerId } : null),
    ...(typeof value.model === "string" ? { model: value.model } : null),
  }
}

async function readIndex(): Promise<NoteMeta[]> {
  if (state.index) return state.index
  const raw = await readJson<unknown[]>(indexPath(), [])
  state.index = (Array.isArray(raw) ? raw : [])
    .map(normalizeMeta)
    .filter((entry): entry is NoteMeta => entry !== null)
  return state.index
}

async function writeIndex(notes: NoteMeta[]) {
  await writeJson(indexPath(), notes)
  state.index = notes
}

function patchIndex(id: string, patch: (meta: NoteMeta) => NoteMeta) {
  return withLock("index", async () => {
    const notes = await readIndex()
    const next = notes.map((meta) => (meta.id === id ? patch(meta) : meta))
    await writeIndex(next)
    return next.find((meta) => meta.id === id)
  })
}

export function subscribeNote(id: string, listener: (event: NoteEvent) => void) {
  state.bus.on(id, listener)
  return () => {
    state.bus.off(id, listener)
  }
}

function emit(id: string, event: NoteEvent) {
  state.bus.emit(id, event)
}

export async function listNotes(): Promise<NoteMeta[]> {
  return [...(await readIndex())].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getNoteMeta(id: string): Promise<NoteMeta | null> {
  if (!isValidNoteId(id)) return null
  return (await readIndex()).find((meta) => meta.id === id) ?? null
}

type HistoryFile = { entries: (NoteHistoryEntry & { content: string })[] }

async function readHistory(id: string): Promise<HistoryFile> {
  const file = await readJson<HistoryFile>(historyPath(id), { entries: [] })
  return Array.isArray(file.entries) ? file : { entries: [] }
}

async function recordHistory(id: string, entry: NoteHistoryEntry & { content: string }) {
  const file = await readHistory(id)
  const last = file.entries.at(-1)
  if (
    last &&
    last.author === "user" &&
    entry.author === "user" &&
    entry.at - last.at < HISTORY_COALESCE_MS
  ) {
    file.entries[file.entries.length - 1] = entry
  } else {
    file.entries.push(entry)
  }
  file.entries = file.entries.slice(-MAX_HISTORY)
  await writeJson(historyPath(id), file)
}

export async function listNoteHistory(id: string): Promise<NoteHistoryEntry[]> {
  return (await readHistory(id)).entries.map(({ rev, at, author }) => ({ rev, at, author })).reverse()
}

export async function readNoteAt(id: string, rev: number): Promise<string | undefined> {
  return (await readHistory(id)).entries.find((entry) => entry.rev === rev)?.content
}

/**
 * Writes a new revision. Callers hold the note's lock and have already
 * decided the content; this bumps the rev, stores the file, the index row and
 * the history, then tells every open page.
 */
async function commit(meta: NoteMeta, content: string, author: NoteAuthor): Promise<NoteDoc> {
  const now = Date.now()
  await mkdir(notesDir(), { recursive: true })
  await writeFileAtomic(notePath(meta.id), content)
  const next = (await patchIndex(meta.id, (row) => ({
    ...row,
    rev: row.rev + 1,
    updatedAt: now,
    title: noteTitle(content) || UNTITLED_NOTE,
  })))!
  await recordHistory(meta.id, { rev: next.rev, at: now, author, content })
  emit(meta.id, { type: "content", rev: next.rev, author })
  return { meta: next, content }
}

async function readContent(id: string) {
  try {
    return await readFile(notePath(id), "utf8")
  } catch {
    return ""
  }
}

/**
 * The note as it is on disk. A file changed outside the app — in another
 * editor, or by an agent's own file tools — is taken in as a revision of its
 * own, so the guard and the merge measure from what is really there.
 */
async function currentDoc(meta: NoteMeta): Promise<NoteDoc> {
  const content = await readContent(meta.id)
  const history = await readHistory(meta.id)
  const last = history.entries.at(-1)
  if (last && last.rev === meta.rev && last.content !== content) {
    return commit(meta, content, "external")
  }
  return { meta, content }
}

export async function readNote(id: string): Promise<NoteDoc | null> {
  const meta = await getNoteMeta(id)
  if (!meta) return null
  return withLock(id, () => currentDoc(meta))
}

export function newNoteId() {
  return `n${randomBytes(8).toString("hex")}`
}

export async function createNote(content = ""): Promise<NoteDoc> {
  const id = newNoteId()
  const now = Date.now()
  const meta: NoteMeta = {
    id,
    title: noteTitle(content) || UNTITLED_NOTE,
    createdAt: now,
    updatedAt: now,
    rev: 1,
  }
  await mkdir(notesDir(), { recursive: true })
  await writeFileAtomic(notePath(id), content)
  await withLock("index", async () => writeIndex([meta, ...(await readIndex())]))
  await recordHistory(id, { rev: 1, at: now, author: "user", content })
  return { meta, content }
}

export type SaveResult = NoteDoc & {
  /** True when the save started from an older rev and was merged. */
  merged: boolean
}

/**
 * The person's save. `base` is the content at `baseRev` as the page last saw
 * it; when another write landed since, the three are merged block by block,
 * so neither the agent's change nor the person's typing is lost.
 */
export async function saveNote(
  id: string,
  input: { content: string; baseRev: number; base?: string }
): Promise<SaveResult | null> {
  const meta = await getNoteMeta(id)
  if (!meta) return null
  return withLock(id, async () => {
    const current = await currentDoc((await getNoteMeta(id))!)
    // The base decides, by content when the page sent it: a page whose base
    // is what is on disk has seen every write, whatever revision it counted.
    const upToDate = input.base !== undefined ? input.base === current.content : input.baseRev === current.meta.rev
    if (upToDate) {
      if (input.content === current.content) return { ...current, merged: false }
      return { ...(await commit(current.meta, input.content, "user")), merged: false }
    }
    const base = input.base ?? (await readNoteAt(id, input.baseRev)) ?? ""
    const merged = mergeNotes(base, input.content, current.content)
    if (merged === current.content) return { ...current, merged: true }
    return { ...(await commit(current.meta, merged, "user")), merged: true }
  })
}

/** The agent's edit: block ops against the note as it stands now. */
export async function editNote(
  id: string,
  ops: NoteOp[]
): Promise<{ rev: number; result: NoteOpsResult }> {
  return withLock(id, async () => {
    const meta = await getNoteMeta(id)
    if (!meta) throw new Error("The note was deleted.")
    const current = await currentDoc(meta)
    const result = applyNoteOps(current.content, ops)
    if (!result.ok || result.source === current.content) return { rev: current.meta.rev, result }
    if (result.source.length > MAX_NOTE_CHARS) {
      return {
        rev: current.meta.rev,
        result: { ok: false, error: { index: 0, code: "invalid", message: "The note would grow past its size limit." } },
      }
    }
    const saved = await commit(current.meta, result.source, "agent")
    return { rev: saved.meta.rev, result }
  })
}

/** Takes out every placeholder an agent planted and never filled. */
export async function clearPending(id: string) {
  return withLock(id, async () => {
    const meta = await getNoteMeta(id)
    if (!meta) return
    const current = await currentDoc(meta)
    const next = stripPending(current.content)
    if (next !== current.content) await commit(current.meta, next, "agent")
  })
}

export async function restoreNote(id: string, rev: number): Promise<NoteDoc | null> {
  const content = await readNoteAt(id, rev)
  if (content === undefined) return null
  return withLock(id, async () => {
    const meta = await getNoteMeta(id)
    if (!meta) return null
    const current = await currentDoc(meta)
    if (current.content === content) return current
    return commit(current.meta, content, "user")
  })
}

export async function setNoteAgent(id: string, patch: Pick<NoteMeta, "chatId" | "providerId" | "model">) {
  return patchIndex(id, (meta) => ({ ...meta, ...patch }))
}

export async function deleteNote(id: string): Promise<NoteMeta | null> {
  const meta = await getNoteMeta(id)
  if (!meta) return null
  await withLock(id, async () => {
    await withLock("index", async () => writeIndex((await readIndex()).filter((row) => row.id !== id)))
    await Promise.all(
      [notePath(id), threadsPath(id), historyPath(id)].map((path) => rm(path, { force: true }))
    )
  })
  return meta
}

export async function listThreads(id: string): Promise<NoteThread[]> {
  const raw = await readJson<NoteThread[]>(threadsPath(id), [])
  return Array.isArray(raw) ? raw : []
}

/** Read-modify-write of a note's threads, under its own lock. */
export function updateThreads<T>(id: string, change: (threads: NoteThread[]) => { threads: NoteThread[]; value: T }) {
  return withLock(`${id}:threads`, async () => {
    const { threads, value } = change(await listThreads(id))
    await writeJson(threadsPath(id), threads)
    emit(id, { type: "threads" })
    return value
  })
}

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
}

const TYPE_EXTENSIONS: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_TYPES).map(([ext, type]) => [type, ext])
)

/** Only names this module minted: a hash, an optional slug, a known extension. */
export function isAssetName(name: string) {
  return /^[a-f0-9]{12}(-[a-z0-9-]{1,48})?\.(png|jpe?g|gif|webp|svg|avif)$/.test(name)
}

export function assetType(name: string) {
  return IMAGE_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream"
}

/**
 * Stores an image and returns the path a note writes for it, `assets/<name>`
 * — relative, so the vault stays a folder of markdown that reads anywhere.
 * Named by content hash: pasting the same picture twice stores it once.
 */
export async function saveAsset(bytes: Uint8Array, fileName: string, type: string) {
  const ext =
    TYPE_EXTENSIONS[type] ??
    (IMAGE_TYPES[extname(fileName).toLowerCase()] ? extname(fileName).toLowerCase() : "")
  if (!ext) throw new Error("Only images can be stored in a note.")
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12)
  const slug = fileName
    .replace(/\.[^.]*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  const name = `${hash}${slug ? `-${slug}` : ""}${ext === ".jpeg" ? ".jpg" : ext}`
  const dir = assetsDir()
  await mkdir(dir, { recursive: true })
  const target = join(/*turbopackIgnore: true*/ dir, name)
  const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`
  await writeFile(temp, bytes)
  await rename(temp, target)
  return `assets/${name}`
}

export async function readAsset(name: string) {
  if (!isAssetName(name)) return null
  try {
    return await readFile(join(/*turbopackIgnore: true*/ assetsDir(), name))
  } catch {
    return null
  }
}
