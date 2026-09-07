import path from "node:path"

import { NextResponse } from "next/server"

import { realPath } from "@/lib/fs-roots"
import { runGit } from "@/lib/git-exec"
import { invalidateGitStatus } from "@/lib/git-status"
import { crossOriginRefusal } from "@/lib/request-origin"
import { getSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const GIT_TIMEOUT_MS = 5_000

/**
 * `POST /api/git/revert { sessionId, path }` — throws away the working-tree
 * changes to one file: `git checkout -- <file>` for a tracked file, and a
 * refusal for an untracked one (deleting a new file is a different, louder
 * action than restoring an edited one, and the UI does not offer it).
 *
 * The file is resolved against the chat's stored folder and must stay inside
 * it; git only ever sees a relative path as an argument after `--`.
 *
 * **And that path is a pathspec, not a file name.** This is the reason
 * `lib/git-exec` puts `--literal-pathspecs` in front of every command it runs.
 * The path here is whatever a tool call or an answer said, and to git
 * `report[1].md` is a character class, `*.bak` is a glob and `:(exclude)src`
 * is a magic pathspec — so a "revert this one file" on a name with a bracket
 * in it silently reverted a different file, and on a name with a star in it
 * reverted every file that matched. The flag turns all of that back into the
 * literal name it always looked like.
 */
export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  let body: { sessionId?: string; path?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const requested = body.path?.trim()
  if (!requested || !body.sessionId) {
    return NextResponse.json(
      { error: "sessionId and path are required" },
      { status: 400 }
    )
  }
  const session = await getSession(body.sessionId)
  const root = session?.cwd?.trim()
  if (!root) {
    return NextResponse.json(
      { error: "This chat has no working folder" },
      { status: 400 }
    )
  }
  const resolvedRoot = path.resolve(root)
  // Real paths on both sides: a symlink in the folder must not become a way of
  // running `git checkout` against a file outside it.
  const realRoot = await realPath(resolvedRoot)
  const target = await realPath(path.resolve(resolvedRoot, requested))
  if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
    return NextResponse.json(
      { error: "That path is outside the chat's folder" },
      { status: 403 }
    )
  }
  const relative = path.relative(realRoot, target)

  const tracked = await runGit(["ls-files", "--error-unmatch", "--", relative], {
    cwd: resolvedRoot,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (!tracked.ok || !tracked.stdout.trim()) {
    return NextResponse.json(
      { error: "That file is not tracked by git — nothing to restore" },
      { status: 409 }
    )
  }

  const reverted = await runGit(["checkout", "--", relative], {
    cwd: resolvedRoot,
    timeoutMs: GIT_TIMEOUT_MS,
    readOnlyConfig: false,
  })
  if (!reverted.ok) {
    return NextResponse.json(
      { error: reverted.stderr.trim() || "git checkout failed" },
      { status: 500 }
    )
  }
  // The sidebar's dirty count is a second stale by design; this is not a poll.
  invalidateGitStatus(resolvedRoot)
  return NextResponse.json({ ok: true, path: relative })
}
