/**
 * Composer state that survives a chat switch and a reload: the draft each
 * chat had in its composer, and the stash — prompts parked with ⌘S.
 *
 * Both live in localStorage as text. A draft's files stay in memory only
 * (`app/page.tsx` keeps them on the live map) and are lost with the tab,
 * which is the honest trade: a File cannot be serialised without copying it.
 */

const DRAFTS_KEY = "agent-ui:drafts"
const STASH_KEY = "agent-ui:stash"
const MAX_DRAFT_CHARS = 20_000
const MAX_STASH = 20

export type StashEntry = {
  id: string
  text: string
  createdAt: number
  /** Names only — the File objects, when still around, ride on `files`. */
  fileNames: string[]
  files?: File[]
  skills: string[]
}

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota, private mode — the draft is a convenience */
  }
}

export function readDrafts(): Record<string, string> {
  const drafts = read<Record<string, string>>(DRAFTS_KEY)
  return drafts && typeof drafts === "object" ? drafts : {}
}

/** Writes one chat's draft; an empty draft removes the key. */
export function writeDraft(sessionId: string, text: string) {
  if (!sessionId) return
  const drafts = readDrafts()
  const trimmed = text.slice(0, MAX_DRAFT_CHARS)
  if (trimmed.trim()) drafts[sessionId] = trimmed
  else delete drafts[sessionId]
  write(DRAFTS_KEY, drafts)
}

export function readStash(): StashEntry[] {
  const entries = read<StashEntry[]>(STASH_KEY)
  if (!Array.isArray(entries)) return []
  return entries
    .filter(
      (entry): entry is StashEntry =>
        !!entry &&
        typeof entry.id === "string" &&
        typeof entry.text === "string"
    )
    .map((entry) => ({
      id: entry.id,
      text: entry.text,
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
      fileNames: Array.isArray(entry.fileNames) ? entry.fileNames : [],
      skills: Array.isArray(entry.skills) ? entry.skills : [],
    }))
    .slice(0, MAX_STASH)
}

/** Persists the stash without its File objects. */
export function writeStash(entries: StashEntry[]) {
  write(
    STASH_KEY,
    entries.slice(0, MAX_STASH).map(({ id, text, createdAt, fileNames, skills }) => ({
      id,
      text,
      createdAt,
      fileNames,
      skills,
    }))
  )
}
