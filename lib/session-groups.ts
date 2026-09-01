import type { ChatSidebarItemData } from "@/components/ui/chat-sidebar"
import type { SessionMeta } from "@/lib/store/types"

/**
 * How the sidebar splits the chat index into sections: the pinned ones first,
 * then one section per working folder.
 *
 * Grouping by folder is what makes the sidebar readable once a machine holds
 * chats for several checkouts — the folder a chat runs in places it faster than
 * the model it happens to use. The pinned group stays flat and keeps the
 * hand-made order (`SessionMeta.order`); folder groups are ordered by activity,
 * because a per-folder manual order has nothing to persist into.
 *
 * Pure and display-only: nothing here reads a repository or touches the store.
 */

/** List id of the group holding chats that named no folder. */
export const NO_FOLDER_GROUP_ID = "no-folder"
/** List id of the pinned group. */
export const PINNED_GROUP_ID = "pinned"

export type SessionGroup = {
  /** Stable list id — also the key its open/closed state is stored under. */
  id: string
  /** Absolute folder path, or "" for the group of chats without one. */
  cwd: string
  /** Header text: the folder's last segment, widened on collision. */
  label: string
  /** Branch of the group's most recent chat, if it recorded one. */
  branch?: string
  /** A chat in the group is streaming — the header says so while collapsed. */
  running: boolean
  /** Newest `updatedAt` in the group, which is what orders the groups. */
  updatedAt: number
  items: ChatSidebarItemData[]
}

export type SessionGroups = {
  pinned: ChatSidebarItemData[]
  folders: SessionGroup[]
}

const EMPTY_GROUPS: SessionGroups = { pinned: [], folders: [] }

/** Trailing separators only: two spellings of one folder must not split it. */
function normalizeFolder(cwd: string | undefined) {
  return (cwd ?? "").trim().replace(/[\\/]+$/, "")
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
 */
function widenCollisions(groups: SessionGroup[]) {
  const counts = new Map<string, number>()
  for (const group of groups) {
    counts.set(group.label, (counts.get(group.label) ?? 0) + 1)
  }
  return groups.map((group) =>
    group.cwd && (counts.get(group.label) ?? 0) > 1
      ? { ...group, label: tailSegments(group.cwd, 2) }
      : group
  )
}

/** The section a chat is filed under — for opening the one holding a chat. */
export function groupIdForSession(
  session: Pick<SessionMeta, "pinned" | "cwd">
) {
  if (session.pinned) return PINNED_GROUP_ID
  const cwd = normalizeFolder(session.cwd)
  return cwd ? `folder:${cwd}` : NO_FOLDER_GROUP_ID
}

/**
 * Splits the sidebar index into its sections. `items` is the rendered view of
 * `sessions` — they are matched by id rather than by position, so a stale
 * render of one cannot mislabel the other.
 */
export function groupSessions(
  sessions: SessionMeta[],
  items: ChatSidebarItemData[]
): SessionGroups {
  if (sessions.length === 0) return EMPTY_GROUPS

  const byId = new Map(items.map((item) => [item.id, item]))
  const pinned: ChatSidebarItemData[] = []
  const buckets = new Map<
    string,
    { cwd: string; entries: Array<{ meta: SessionMeta; item: ChatSidebarItemData }> }
  >()

  for (const session of sessions) {
    const item = byId.get(session.id)
    if (!item) continue
    if (session.pinned) {
      pinned.push(item)
      continue
    }
    const cwd = normalizeFolder(session.cwd)
    const id = groupIdForSession(session)
    const bucket = buckets.get(id) ?? { cwd, entries: [] }
    bucket.entries.push({ meta: session, item })
    buckets.set(id, bucket)
  }

  const folders = Array.from(buckets, ([id, bucket]) => {
    const entries = [...bucket.entries].sort(
      (a, b) => b.meta.updatedAt - a.meta.updatedAt
    )
    return {
      id,
      cwd: bucket.cwd,
      label: bucket.cwd ? tailSegments(bucket.cwd, 1) : "No folder",
      branch: entries.find((entry) => entry.meta.gitBranch)?.meta.gitBranch,
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

  return { pinned, folders: widenCollisions(folders) }
}
