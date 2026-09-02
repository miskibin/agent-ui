import { stat } from "node:fs/promises"

import { NextResponse } from "next/server"

import { gitStatus } from "@/lib/git-status"
import { getSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/git/status?session=<id>` — branch, ahead/behind, dirty count and
 * the branch's pull request, for the sidebar's folder headers.
 *
 * Read-only, but `git status` and `gh` are still programs run in a folder,
 * so the folder is read back from the stored session rather than taken from
 * the query — a page on another origin cannot point them anywhere — and a
 * cross-site request is refused outright.
 */
export async function GET(req: Request) {
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Cross-site request" }, { status: 403 })
  }
  const id = new URL(req.url).searchParams.get("session")?.trim() ?? ""
  const session = id ? await getSession(id) : null
  const path = session?.cwd?.trim()
  if (!path) {
    return NextResponse.json({ error: "That chat has no folder" }, { status: 404 })
  }
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) {
    return NextResponse.json({ error: "No such folder" }, { status: 404 })
  }
  return NextResponse.json(await gitStatus(path))
}
