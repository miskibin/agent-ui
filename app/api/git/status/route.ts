import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"

import { NextResponse } from "next/server"

import { expandHome } from "@/lib/fs-paths"
import { gitStatus } from "@/lib/git-status"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/git/status?path=<folder>` — branch, ahead/behind, dirty count and
 * the branch's pull request, for the sidebar's folder headers. Read-only, and
 * the folder only ever reaches git as `cwd`.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("path")?.trim() ?? ""
  if (!raw) {
    return NextResponse.json({ error: "path is required" }, { status: 400 })
  }
  const path = expandHome(raw)
  if (!isAbsolute(path)) {
    return NextResponse.json({ error: "path must be absolute" }, { status: 400 })
  }
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) {
    return NextResponse.json({ error: "No such folder" }, { status: 404 })
  }
  return NextResponse.json(await gitStatus(path))
}
