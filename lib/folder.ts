/**
 * Per-chat working folder — the shape the picker and the validation route
 * share, plus the two string helpers the UI needs. No `node:path` here: this
 * runs in the browser, and the only thing the client does with a path is
 * display it.
 */

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

/** Middle-truncates a long path for a one-line label. */
export function shortPath(path: string, max = 44): string {
  if (path.length <= max) return path
  const head = Math.ceil((max - 1) / 2)
  return `${path.slice(0, head)}…${path.slice(path.length - (max - head - 1))}`
}
