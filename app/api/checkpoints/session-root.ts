import "server-only"

import path from "node:path"

import { isGitWorktree } from "@/lib/checkpoints"
import { isWithinReal } from "@/lib/fs-roots"
import { dataDir } from "@/lib/settings/server"
import { getSession } from "@/lib/store/sessions"

/**
 * The folder a checkpoint route is allowed to run git in.
 *
 * The same discipline as `POST /api/git/revert`, and for the same reason —
 * these routes write to the user's disk. The folder is read back from the
 * stored session, so the client names a *chat* and never a path; the app's own
 * data directory is refused outright even if a chat were somehow pointed at
 * it; and a folder that is not a checkout is a 409 rather than a git command
 * run somewhere it does not belong.
 */
export type CheckpointRoot =
  | { ok: true; cwd: string }
  | { ok: false; error: string; status: number }

export async function checkpointRoot(
  sessionId: string | undefined
): Promise<CheckpointRoot> {
  const id = sessionId?.trim()
  if (!id) return { ok: false, error: "sessionId is required", status: 400 }
  const session = await getSession(id)
  if (!session) return { ok: false, error: "Session not found", status: 404 }
  const cwd = session.cwd?.trim()
  if (!cwd) {
    return { ok: false, error: "This chat has no working folder", status: 400 }
  }
  const resolved = path.resolve(cwd)
  if (await isWithinReal(dataDir(), resolved)) {
    return { ok: false, error: "That folder is not writable", status: 403 }
  }
  if (!(await isGitWorktree(resolved))) {
    return { ok: false, error: "That folder is not a git repository", status: 409 }
  }
  return { ok: true, cwd: resolved }
}

/** A turn number off the wire: a non-negative integer, or null. */
export function parseTurn(value: unknown): number | null {
  const turn = typeof value === "string" ? Number(value) : value
  if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 0) {
    return null
  }
  return turn
}
