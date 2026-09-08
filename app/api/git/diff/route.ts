import { stat } from "node:fs/promises"

import { NextResponse } from "next/server"

import { changedFiles } from "@/lib/git-diff"
import { crossOriginRefusal } from "@/lib/request-origin"
import { getSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/git/diff?session=<id>` — every changed file in the chat's folder,
 * with its own patch, for the changes panel.
 *
 * Same rule as every other file route: the folder is read back from the stored
 * chat rather than taken from the query, so a page on another origin cannot
 * point `git diff` anywhere, and a cross-site request is refused outright.
 */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const id = new URL(req.url).searchParams.get("session")?.trim() ?? ""
  const session = id ? await getSession(id) : null
  const cwd = session?.cwd?.trim()
  if (!cwd) {
    return NextResponse.json({ error: "That chat has no folder" }, { status: 404 })
  }
  const info = await stat(cwd).catch(() => null)
  if (!info?.isDirectory()) {
    return NextResponse.json({ error: "No such folder" }, { status: 404 })
  }
  return NextResponse.json({ files: await changedFiles(cwd) })
}
