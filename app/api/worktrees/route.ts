import { NextResponse } from "next/server"

import { invalidateGitStatus } from "@/lib/git-status"
import { crossOriginRefusal } from "@/lib/request-origin"
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
} from "@/lib/worktree"

import {
  resolveRemovable,
  resolveRepo,
  startFromOriginDefault,
} from "./repo-root"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The worktrees of one repository: list them, make one, remove one.
 *
 * A chat that starts in a worktree gets a checkout of its own, so two agents
 * can work on the same project without stepping on each other's files. The
 * folder the route hands back becomes the chat's `cwd`, and everything else in
 * the app — the sidebar section, the file panel's root, the handoff snapshot —
 * follows from that one field without knowing a worktree is involved.
 *
 * Every path in and out is absolute and validated in `./repo-root`: this route
 * creates and deletes directories.
 */

/** `GET /api/worktrees?repoRoot=…` — what this repository has registered. */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const repo = await resolveRepo(
    new URL(req.url).searchParams.get("repoRoot") ?? ""
  )
  if (!repo.ok) {
    return NextResponse.json({ error: repo.error }, { status: repo.status })
  }
  return NextResponse.json({
    repoRoot: repo.repoRoot,
    worktrees: await listWorktrees(repo.repoRoot),
  })
}

/**
 * `POST /api/worktrees { repoRoot, title?, branch?, baseRef?, startFromOrigin? }`
 * — a new worktree on a new branch, under `$AGENT_UI_DIR/worktrees`.
 *
 * `title` is the chat's, and only names the branch when none was given.
 */
export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  let body: {
    repoRoot?: string
    title?: string
    branch?: string
    baseRef?: string
    startFromOrigin?: boolean
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const repo = await resolveRepo(body.repoRoot)
  if (!repo.ok) {
    return NextResponse.json({ error: repo.error }, { status: repo.status })
  }

  const created = await createWorktree({
    repoRoot: repo.repoRoot,
    branch: typeof body.branch === "string" ? body.branch : undefined,
    title: typeof body.title === "string" ? body.title : undefined,
    baseRef: typeof body.baseRef === "string" ? body.baseRef : undefined,
    startFromOrigin:
      typeof body.startFromOrigin === "boolean"
        ? body.startFromOrigin
        : await startFromOriginDefault(),
  })
  if (!created.ok) {
    return NextResponse.json({ error: created.error }, { status: created.status })
  }
  // A new branch on the repository the sidebar is already showing a badge for.
  invalidateGitStatus(repo.repoRoot)
  return NextResponse.json(
    {
      root: created.root,
      branch: created.branch,
      baseBranch: created.baseBranch,
      repoRoot: created.repoRoot,
    },
    { status: 201 }
  )
}

/**
 * `DELETE /api/worktrees { repoRoot, root, branch?, force? }` — removes a
 * worktree and, when it is named, the branch that was checked out in it.
 *
 * Idempotent: a worktree already gone is a success. Without `force` a worktree
 * holding uncommitted changes is refused, which is what turns the confirmation
 * into a real question rather than a formality.
 */
export async function DELETE(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  let body: {
    repoRoot?: string
    root?: string
    branch?: string
    force?: boolean
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const repo = await resolveRepo(body.repoRoot)
  if (!repo.ok) {
    return NextResponse.json({ error: repo.error }, { status: repo.status })
  }
  const target = await resolveRemovable(repo.repoRoot, body.root)
  if (!target.ok) {
    return NextResponse.json({ error: target.error }, { status: target.status })
  }

  const removed = await removeWorktree(repo.repoRoot, target.root, {
    force: body.force === true,
    // The branch git says is checked out there wins over the one the client
    // remembers: the client's copy can be a rename old.
    branch:
      target.branch ?? (typeof body.branch === "string" ? body.branch : undefined),
  })
  if (!removed.ok) {
    return NextResponse.json({ error: removed.error }, { status: removed.status })
  }
  invalidateGitStatus(repo.repoRoot)
  invalidateGitStatus(target.root)
  return NextResponse.json({
    ok: true,
    removed: removed.removed,
    branchDeleted: removed.branchDeleted,
  })
}
