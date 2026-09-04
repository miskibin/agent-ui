import "server-only"

import { realpath } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"

import type { AppSettings } from "@/lib/settings/schema"
import { dataDir } from "@/lib/settings/server"
import { listSessions } from "@/lib/store/sessions"

/**
 * The folders the app already reads and writes on the user's behalf: its data
 * directory, its own cwd, the agent workspaces and every chat's folder. What
 * `files.anyPath` narrows the file routes to, and what the open route is
 * confined to under the same switch.
 *
 * Containment is decided on *real* paths. A lexical comparison believes a
 * symlink: `<root>/link` pointing at `/` makes `<root>/link/etc/shadow` look
 * like a file inside the root, and an agent writes symlinks. So every check
 * here resolves both sides first — see `realPath`.
 */

export function isWithin(root: string, path: string) {
  const from = resolve(root)
  const to = resolve(path)
  return to === from || to.startsWith(from.endsWith(sep) ? from : `${from}${sep}`)
}

/**
 * The path with every symlink on it followed. A path that does not exist yet
 * has none to follow, so the nearest existing ancestor is resolved and the
 * missing tail joined back on: that still catches a link in the part that does
 * exist, without inventing a file.
 */
export async function realPath(path: string): Promise<string> {
  const full = resolve(path)
  const tail: string[] = []
  let current = full
  for (;;) {
    try {
      const real = await realpath(current)
      if (!tail.length) return real
      // Collected leaf-first while walking up; joined root-first.
      tail.reverse()
      return join(real, ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) return full
      tail.push(basename(current))
      current = parent
    }
  }
}

/** `isWithin`, with both sides resolved through the filesystem first. */
export async function isWithinReal(root: string, path: string) {
  return isWithin(await realPath(root), await realPath(path))
}

export async function isWithinKnownRoot(path: string, settings: AppSettings) {
  const sessions = await listSessions().catch(() => [])
  const roots = [
    dataDir(),
    process.cwd(),
    settings.providers.pi.workspace,
    ...Object.values(settings.providers.acp.agents).map((agent) => agent.workspace),
    ...sessions.map((session) => session.cwd ?? ""),
  ]
  // The target is resolved once; a root only when it is worth comparing.
  const target = await realPath(path)
  for (const root of roots) {
    if (!root.trim()) continue
    if (isWithin(await realPath(root), target)) return true
  }
  return false
}
