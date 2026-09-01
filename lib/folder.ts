/**
 * Per-chat working folder — the shape the picker and the validation route
 * share, plus the two string helpers the UI needs. No `node:path` here: this
 * runs in the browser, and the only thing the client does with a path is
 * display it.
 */

/** One directory in the browser's list. Files are never listed. */
export type FolderEntry = {
  name: string
  path: string
  isGitRepo: boolean
  /** Dot-directories are listed last and dimmed rather than hidden. */
  hidden: boolean
}

export type FolderListing = {
  /**
   * The directory that was actually listed. The route is forgiving — asked
   * for a half-typed path it lists the nearest existing ancestor — so this is
   * not necessarily what the caller sent.
   */
  path: string
  /** Parent directory, or `null` at the filesystem root. */
  parent: string | null
  entries: FolderEntry[]
  /** `entries` hit the cap; the folder has more children than are shown. */
  truncated: boolean
}

export type FolderInfo = {
  /** The path after `~` expansion and resolution — what gets stored. */
  path: string
  exists: boolean
  isDir: boolean
  isGitRepo: boolean
  branches: string[]
  currentBranch: string
}

/** Last segment of a path — `/home/me/agent-ui` → `agent-ui`. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  const segment = trimmed.split(/[\\/]/).pop() ?? ""
  return segment || trimmed || path
}

/**
 * Splits a typed path into "the directory to list" and "what the user has
 * started typing in it" — `/home/me/ag` lists `/home/me` filtered by `ag`,
 * `/home/me/` lists `/home/me` unfiltered. Separator-agnostic, because the
 * server answers for whichever platform it runs on.
 */
export function splitTypedPath(input: string): { dir: string; filter: string } {
  const index = Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\"))
  if (index < 0) return { dir: input, filter: "" }
  return {
    // `/foo` must list the root, not the empty string.
    dir: input.slice(0, index) || input.slice(0, index + 1),
    filter: input.slice(index + 1),
  }
}

/** Middle-truncates a long path for a one-line label. */
export function shortPath(path: string, max = 44): string {
  if (path.length <= max) return path
  const head = Math.ceil((max - 1) / 2)
  return `${path.slice(0, head)}…${path.slice(path.length - (max - head - 1))}`
}
