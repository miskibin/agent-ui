import { NextResponse } from "next/server"

import { dataDir } from "@/lib/settings/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/settings/data-dir` — where this machine keeps the app's JSON.
 *
 * The settings *route* reads it server-side, but settings also open as a panel
 * over the chat (so a running turn is not thrown away by a navigation), and a
 * panel has no server render to read `AGENT_UI_DIR` in.
 */
export async function GET() {
  return NextResponse.json({ dataDir: dataDir() })
}
