import { NextResponse } from "next/server"

import { scanImports } from "@/lib/import/import"
import { crossOriginRefusal } from "@/lib/request-origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/import/scan` — every folder Claude Code or Codex has run in on
 * this machine, with how many conversations each has and when it was last
 * touched.
 *
 * Read-only and best-effort: an absent CLI home, an unreadable directory or a
 * transcript that never names its folder is simply not in the answer. It is
 * refused cross-site like every other route that reads the disk — the reply
 * names the user's own project directories, which is not something a page on
 * another origin gets to ask for.
 */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  return NextResponse.json(await scanImports())
}
