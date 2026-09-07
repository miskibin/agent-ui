import { NextResponse } from "next/server"

import { importedSessions, readLedger } from "@/lib/import/ledger"
import { crossOriginRefusal } from "@/lib/request-origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/import/imported` — chat id to the CLI it came from, for whoever
 * draws the "imported" badge.
 *
 * One small file read, deliberately kept out of the sessions index: that file
 * is read on every page load and is the app's hottest, and where a chat came
 * from is not something the sidebar needs before it can paint.
 */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  return NextResponse.json({ sessions: importedSessions(await readLedger()) })
}
