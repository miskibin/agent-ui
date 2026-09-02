import "server-only"

import { resolve, sep } from "node:path"

import type { AppSettings } from "@/lib/settings/schema"
import { dataDir } from "@/lib/settings/server"
import { listSessions } from "@/lib/store/sessions"

/**
 * The folders the app already reads and writes on the user's behalf: its data
 * directory, its own cwd, the agent workspaces and every chat's folder. What
 * `files.anyPath` narrows the file routes to, and what the open route is
 * confined to under the same switch.
 */

export function isWithin(root: string, path: string) {
  const from = resolve(root)
  const to = resolve(path)
  return to === from || to.startsWith(from.endsWith(sep) ? from : `${from}${sep}`)
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
  return roots.some((root) => root.trim() && isWithin(root, path))
}
