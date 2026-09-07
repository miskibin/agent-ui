import path from "node:path"

import { NextResponse } from "next/server"

import { isWithinReal } from "@/lib/fs-roots"
import { crossOriginRefusal } from "@/lib/request-origin"
import { listWorktrees, repoRootOf, worktreeStatus, worktreesRoot } from "@/lib/worktree"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/worktrees/status?root=…` — is this folder a worktree the app
 * made, and what would removing it throw away?
 *
 * It exists for the delete path. A chat only knows its `cwd`; deciding whether
 * that folder is a disposable worktree means asking git which repository owns
 * it and comparing paths against the app's own worktrees folder, and neither
 * is a question a browser can answer. Answering it here also means the offer
 * to clean up works for a chat stored before `SessionMeta.worktree` existed.
 *
 * Never fails loudly: a folder that is gone, is not a checkout, or is the main
 * checkout all come back as `managed: false`, which the caller reads as
 * "nothing to offer".
 */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused

  const requested = new URL(req.url).searchParams.get("root")?.trim() ?? ""
  if (!requested) {
    return NextResponse.json({ error: "root is required" }, { status: 400 })
  }
  const root = path.resolve(requested)
  const repo = await repoRootOf(root)
  if (!repo || !repo.linked) {
    return NextResponse.json({ managed: false, root })
  }

  const registered = await listWorktrees(repo.mainRoot)
  const entry = registered.find(
    (candidate) => path.resolve(candidate.path) === path.resolve(repo.root) && !candidate.main
  )
  // "Managed" is deliberately narrow: a worktree the *user* made elsewhere on
  // disk is theirs, and the app does not offer to delete it.
  const managed = Boolean(entry) && (await isWithinReal(worktreesRoot(), repo.root))
  if (!managed) return NextResponse.json({ managed: false, root: repo.root })

  return NextResponse.json({
    managed: true,
    root: repo.root,
    repoRoot: repo.mainRoot,
    branch: entry?.branch,
    status: await worktreeStatus(repo.root),
  })
}
