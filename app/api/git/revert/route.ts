import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import { NextResponse } from "next/server"

import { realPath } from "@/lib/fs-roots"
import { crossOriginRefusal } from "@/lib/request-origin"
import { getSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 5_000

/**
 * `POST /api/git/revert { sessionId, path }` — throws away the working-tree
 * changes to one file: `git checkout -- <file>` for a tracked file, and a
 * refusal for an untracked one (deleting a new file is a different, louder
 * action than restoring an edited one, and the UI does not offer it).
 *
 * The file is resolved against the chat's stored folder and must stay inside
 * it; git only ever sees a relative path as an argument after `--`.
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

  const git = (args: string[]) =>
    run("git", args, { cwd: resolvedRoot, timeout: GIT_TIMEOUT_MS, windowsHide: true })

  try {
    const { stdout } = await git(["ls-files", "--error-unmatch", "--", relative])
    if (!stdout.trim()) throw new Error("untracked")
  } catch {
    return NextResponse.json(
      { error: "That file is not tracked by git — nothing to restore" },
      { status: 409 }
    )
  }
  try {
    await git(["checkout", "--", relative])
  } catch (err) {
    const message = err instanceof Error ? err.message : "git checkout failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, path: relative })
}
