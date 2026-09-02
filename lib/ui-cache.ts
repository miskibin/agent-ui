/**
 * The page's localStorage snapshots, in one place so the `agent-ui:*` keys are
 * greppable. Every one of them is an optimization only: a read tolerates a
 * missing or malformed entry, and a write tolerates a full or locked-down
 * store, so the app is correct with none of them.
 */

/** Last known sidebar index + open thread, so a reload paints before the fetch. */
export const CACHE_INDEX_KEY = "agent-ui:sessions"
export const CACHE_ACTIVE_KEY = "agent-ui:active-session"

/**
 * Which sidebar folder sections the user closed, keyed by group id. Only the
 * closed ones are worth remembering: a folder seen for the first time — a chat
 * that just picked one — should open, not hide.
 */
export const CACHE_SECTIONS_KEY = "agent-ui:folder-sections"

/** Where the dragged file-panel width is remembered, as a percentage. */
export const CACHE_SPLIT_KEY = "agent-ui:preview-size"
/** The file panel's own preferences: split or unified diff, wrapped lines. */
export const CACHE_PREVIEW_PREFS_KEY = "agent-ui:preview-prefs"

export function readCache<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export function writeCache(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode / quota — the cache is only an optimization */
  }
}
