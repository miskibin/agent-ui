import "server-only"

import path from "node:path"

import { isWithinReal } from "@/lib/fs-roots"
import { dataDir, readSettings } from "@/lib/settings/server"
import { listWorktrees, repoRootOf, worktreesRoot } from "@/lib/worktree"

/**
 * What the worktree routes are allowed to touch.
 *
 * The same discipline as `app/api/checkpoints/session-root.ts`, and for a
 * louder reason: these routes create and *delete* folders on the user's disk.
 * Three rules, and none of them may be relaxed:
 *
 * - A repository path is refused when it is inside the app's data directory,
 *   *except* under `worktrees/` — that one folder is the app's own, and a chat
 *   running in a worktree is allowed to make another one from it.
 * - A removal target has to be either inside that same `worktrees/` folder or
 *   a worktree this repository has actually registered. Anything else is a
 *   path the client made up, and `git worktree remove` is a `rm -rf`.
 * - The main checkout is never removable. Removing it is not a cleanup, it is
 *   the user's project.
 */

export type ResolvedRepo =
  | { ok: true; repoRoot: string; worktreeRoot: string; linked: boolean }
  | { ok: false; error: string; status: number }

/** The repository a request names, resolved to its main checkout. */
export async function resolveRepo(input: unknown): Promise<ResolvedRepo> {
  const requested = typeof input === "string" ? input.trim() : ""
  if (!requested) {
    return { ok: false, error: "repoRoot is required", status: 400 }
  }
  const resolved = path.resolve(requested)
  if (
    (await isWithinReal(dataDir(), resolved)) &&
    !(await isWithinReal(worktreesRoot(), resolved))
  ) {
    return { ok: false, error: "That folder is not writable", status: 403 }
  }
  const repo = await repoRootOf(resolved)
  if (!repo) {
    return { ok: false, error: "That folder is not a git repository", status: 409 }
  }
  return {
    ok: true,
    repoRoot: repo.mainRoot,
    worktreeRoot: repo.root,
    linked: repo.linked,
  }
}

export type RemovableRoot =
  | { ok: true; root: string; branch?: string }
  | { ok: false; error: string; status: number }

/**
 * The worktree a removal names — refused unless it is one the app made or one
 * this repository has registered, and never the main checkout.
 */
export async function resolveRemovable(
  repoRoot: string,
  input: unknown
): Promise<RemovableRoot> {
  const requested = typeof input === "string" ? input.trim() : ""
  if (!requested) return { ok: false, error: "root is required", status: 400 }
  const root = path.resolve(requested)
  if (root === path.resolve(repoRoot)) {
    return { ok: false, error: "That is the repository itself", status: 403 }
  }

  const registered = await listWorktrees(repoRoot)
  const match = registered.find(
    (entry) => path.resolve(entry.path) === root && !entry.main
  )
  const ours = await isWithinReal(worktreesRoot(), root)
  if (!match && !ours) {
    return { ok: false, error: "That folder is not a worktree of this repository", status: 403 }
  }
  return { ok: true, root, branch: match?.branch }
}

/**
 * Whether a new worktree starts from `origin/<default>` rather than the local
 * default branch. Read through a cast because the key is optional: the setting
 * belongs to the settings schema, and this feature works — starting from
 * `origin` — whether or not that schema has grown the switch yet.
 */
export async function startFromOriginDefault(): Promise<boolean> {
  const settings = await readSettings().catch(() => null)
  const chat = (settings?.chat ?? {}) as Record<string, unknown>
  const configured = chat.newWorktreesStartFromOrigin
  return typeof configured === "boolean" ? configured : true
}
