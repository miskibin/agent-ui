import type { ChatSidebarItemData } from "@/components/ui/chat-sidebar"
import {
  normalizeFolder,
  normalizeFolderForComparison,
} from "@/lib/folder-identity"
import { folderName } from "@/lib/folder"
import { sessionSection, settledTimestamp } from "@/lib/session-lifecycle"
import type { SessionMeta } from "@/lib/store/types"

/**
 * How the sidebar splits the chat index into sections: the pinned ones first,
 * then one section per working folder, then the two shelves — Snoozed and
 * Settled — that hold the chats which are not in play right now.
 *
 * Grouping by folder is what makes the sidebar readable once a machine holds
 * chats for several checkouts — the folder a chat runs in places it faster than
 * the model it happens to use. The pinned group stays flat and keeps the
 * hand-made order (`SessionMeta.order`); folder groups are ordered by activity,
 * because a per-folder manual order has nothing to persist into.
 *
 * The shelves are the other half of the same idea: a sidebar that only ever
 * grows is a sidebar nobody reads, so a chat that has been put down or
 * finished leaves the folder it belongs to and goes under one collapsed
 * header, paged, with the folder sections left holding only live work. What
 * lands where is `lib/session-lifecycle`'s call, not this file's.
 *
 * Pure and display-only: nothing here reads a repository or touches the store.
 */

/** List id of the group holding chats that named no folder. */
export const NO_FOLDER_GROUP_ID = "no-folder"
/** List id of the pinned group. */
export const PINNED_GROUP_ID = "pinned"
/** List ids of the two shelves. */
export const SNOOZED_SHELF_ID = "shelf:snoozed"
export const SETTLED_SHELF_ID = "shelf:settled"

/** Rows a shelf shows before "Show more", and how many each press adds. */
export const SHELF_PAGE_SIZE = 10
export const SHELF_PAGE_STEP = 25

/**
 * Where a shelf's fold state is remembered.
 *
 * The sidebar's section cache stores the sections the user *closed* — absent
 * means open, so a folder seen for the first time shows its chats. A shelf
 * wants the opposite default, so it is stored under a key of its own whose
 * presence means *open*. Two polarities in one record is worth one comment
 * and saves a second cache: the key spaces cannot collide, and because these
 * keys are new, every existing sidebar starts with both shelves closed.
 */
export function shelfOpenKey(shelfId: string) {
  return `${shelfId}:open`
}

export type SessionGroup = {
  /** Stable list id — also the key its open/closed state is stored under. */
  id: string
  /** Absolute folder path, or "" for the group of chats without one. */
  cwd: string
  /** Header text: the folder's last segment, widened on collision. */
  label: string
  /** Branch of the group's most recent chat, if it recorded one. */
  branch?: string
  /**
   * The group's folder is a worktree the app made, so the header names the
   * *repository* it belongs to and the branch line is the worktree's own.
   */
  worktree: boolean
  /** A chat in the group is streaming — the header says so while collapsed. */
  running: boolean
  /** Newest `updatedAt` in the group, which is what orders the groups. */
  updatedAt: number
  items: ChatSidebarItemData[]
}

/**
 * One of the two shelves. `items` is what to render right now — the shelf
 * closed, or open and paged — while `total` and `hidden` are what the header
 * and the "Show more" row say, so neither has to count for itself.
 */
export type SessionShelf = {
  id: string
  label: string
  items: ChatSidebarItemData[]
  total: number
  hidden: number
}

export type SessionGroups = {
  pinned: ChatSidebarItemData[]
  folders: SessionGroup[]
  snoozed: SessionShelf
  settled: SessionShelf
}

export type GroupOptions = {
  /** The instant the split is taken at — a snooze expires against this. */
  now?: number
  /**
   * Chats that must stay reachable even when they are paged out or the shelf
   * holding them is closed: the open chat, above all. Deep-linking into a
   * settled conversation and finding no row to un-settle is a dead end.
   */
  keepVisible?: readonly string[]
  snoozedOpen?: boolean
  settledOpen?: boolean
  /** How many rows each shelf is currently paged to. */
  snoozedVisible?: number
  settledVisible?: number
}

function emptyShelf(id: string, label: string): SessionShelf {
  return { id, label, items: [], total: 0, hidden: 0 }
}

const EMPTY_GROUPS: SessionGroups = {
  pinned: [],
  folders: [],
  snoozed: emptyShelf(SNOOZED_SHELF_ID, "Snoozed"),
  settled: emptyShelf(SETTLED_SHELF_ID, "Settled"),
}

/**
 * The folder as it is *shown*: trailing separators trimmed, nothing else
 * touched, so the header and the row menu name the path the user gave.
 */
function displayFolder(cwd: string | undefined) {
  return normalizeFolder(cwd ?? "")
}

/**
 * The folder as it is *compared*, which on Windows also folds separators and
 * case — `C:\repo` and `c:/repo/` are one section, not two.
 */
function folderKey(cwd: string | undefined) {
  return normalizeFolderForComparison(cwd)
}

/** The last `count` segments of a path, joined the way the path spells them. */
function tailSegments(path: string, count: number) {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0) return path
  const sep = path.includes("\\") ? "\\" : "/"
  return parts.slice(-count).join(sep)
}

/**
 * Two checkouts of the same project ("api" under two roots) would otherwise
 * produce two identical headers, so a colliding label grows a parent segment.
 * A worktree group widens along its *repository* path, which is the path its
 * label came from.
 */
function widenCollisions(
  groups: Array<SessionGroup & { labelPath: string }>
): SessionGroup[] {
  const counts = new Map<string, number>()
  for (const group of groups) {
    counts.set(group.label, (counts.get(group.label) ?? 0) + 1)
  }
  return groups.map(({ labelPath, ...group }) =>
    labelPath && (counts.get(group.label) ?? 0) > 1
      ? { ...group, label: tailSegments(labelPath, 2) }
      : group
  )
}

/**
 * The folder section a chat belongs to — what the rename request opens, and
 * what a drag back out of the pinned group lands in. Deliberately unaware of
 * the lifecycle: this answers "which folder", and `sidebarListId` is the one
 * that answers "which list is it in right now".
 */
export function groupIdForSession(
  session: Pick<SessionMeta, "pinned" | "cwd">
) {
  if (session.pinned) return PINNED_GROUP_ID
  const key = folderKey(session.cwd)
  return key ? `folder:${key}` : NO_FOLDER_GROUP_ID
}

/**
 * The list a chat is actually rendered in, shelves included. Drag and drop
 * reads this: the verb a drop means is entirely a question of which list the
 * row came from and which one it is over.
 */
export function sidebarListId(session: SessionMeta, now = Date.now()) {
  const section = sessionSection(session, now)
  if (section === "snoozed") return SNOOZED_SHELF_ID
  if (section === "settled") return SETTLED_SHELF_ID
  return groupIdForSession(session)
}

/**
 * Splits the sidebar index into its sections. `items` is the rendered view of
 * `sessions` — they are matched by id rather than by position, so a stale
 * render of one cannot mislabel the other.
 */
export function groupSessions(
  sessions: SessionMeta[],
  items: ChatSidebarItemData[],
  options: GroupOptions = {}
): SessionGroups {
  if (sessions.length === 0) return EMPTY_GROUPS

  const now = options.now ?? Date.now()
  const keep = new Set(options.keepVisible ?? [])
  const byId = new Map(items.map((item) => [item.id, item]))
  const pinned: ChatSidebarItemData[] = []
  const snoozed: Entry[] = []
  const settled: Entry[] = []
  const buckets = new Map<string, { cwd: string; entries: Entry[] }>()

  for (const session of sessions) {
    const item = byId.get(session.id)
    if (!item) continue
    const entry = { meta: session, item }
    const section = sessionSection(session, now)
    if (section === "snoozed") {
      snoozed.push(entry)
      continue
    }
    if (section === "settled") {
      settled.push(entry)
      continue
    }
    if (section === "pinned") {
      pinned.push(item)
      continue
    }
    // Keyed by identity, labelled by the first spelling seen — two chats that
    // spell one Windows folder differently share a section, and the section
    // still says what the user typed.
    const cwd = displayFolder(session.cwd)
    const id = groupIdForSession(session)
    const bucket = buckets.get(id) ?? { cwd, entries: [] }
    bucket.entries.push(entry)
    buckets.set(id, bucket)
  }

  const folders = Array.from(buckets, ([id, bucket]) => {
    const entries = [...bucket.entries].sort(
      (a, b) => b.meta.updatedAt - a.meta.updatedAt
    )
    // The newest chat is what the header describes: its worktree, else its
    // branch. A folder holding one worktree chat and one plain chat is still
    // one folder — this only decides what the header calls it.
    const worktree = entries[0]?.meta.worktree
    const labelPath = worktree?.repoRoot || bucket.cwd
    return {
      id,
      cwd: bucket.cwd,
      labelPath,
      label: worktree
        ? folderName(worktree.repoRoot)
        : bucket.cwd
          ? tailSegments(bucket.cwd, 1)
          : "No folder",
      branch:
        worktree?.branch ||
        entries.find((entry) => entry.meta.gitBranch)?.meta.gitBranch,
      worktree: !!worktree,
      running: entries.some((entry) => entry.item.status === "streaming"),
      updatedAt: entries[0]?.meta.updatedAt ?? 0,
      items: entries.map((entry) => entry.item),
    }
  })

  // Busiest folder first; the folderless leftovers always last.
  folders.sort((a, b) => {
    if (!a.cwd !== !b.cwd) return a.cwd ? -1 : 1
    return b.updatedAt - a.updatedAt
  })

  return {
    pinned,
    folders: widenCollisions(folders),
    // Soonest wake first: "what comes back next" is the shelf's question.
    snoozed: shelf(SNOOZED_SHELF_ID, "Snoozed", sortByWake(snoozed), {
      open: options.snoozedOpen === true,
      visible: options.snoozedVisible ?? SHELF_PAGE_SIZE,
      keep,
    }),
    // History, newest first — and by when the work ended, not when the row
    // was last touched.
    settled: shelf(SETTLED_SHELF_ID, "Settled", sortBySettled(settled), {
      open: options.settledOpen === true,
      visible: options.settledVisible ?? SHELF_PAGE_SIZE,
      keep,
    }),
  }
}

type Entry = { meta: SessionMeta; item: ChatSidebarItemData }

function sortByWake(entries: Entry[]) {
  return [...entries].sort(
    (a, b) => (a.meta.snoozedUntil ?? 0) - (b.meta.snoozedUntil ?? 0)
  )
}

function sortBySettled(entries: Entry[]) {
  return [...entries].sort(
    (a, b) =>
      settledTimestamp(b.meta) - settledTimestamp(a.meta) ||
      a.meta.id.localeCompare(b.meta.id)
  )
}

/**
 * A shelf's rendered page.
 *
 * Closed, it renders nothing at all — except the chats in `keep`, which are
 * the one exception the fold makes: the open conversation must never be a row
 * that is not there. Open, it renders its page and then the same exception,
 * appended rather than inserted, because a row pulled out of the deep tail is
 * not part of the recent history above it.
 */
function shelf(
  id: string,
  label: string,
  entries: Entry[],
  {
    open,
    visible,
    keep,
  }: { open: boolean; visible: number; keep: ReadonlySet<string> }
): SessionShelf {
  const page = open ? entries.slice(0, Math.max(0, visible)) : []
  const shown = new Set(page.map((entry) => entry.item.id))
  for (const entry of entries) {
    if (keep.has(entry.item.id) && !shown.has(entry.item.id)) page.push(entry)
  }
  return {
    id,
    label,
    items: page.map((entry) => entry.item),
    total: entries.length,
    hidden: entries.length - page.length,
  }
}
