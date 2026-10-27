import { NextResponse } from "next/server"

import { memoryStatus } from "@/lib/memory/status"
import { readSettings } from "@/lib/settings/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/memory/status[?retry=1]` — the chat page's boot check. Starting
 * Ollama is its side effect, which is why the page asks once on open rather
 * than on every render; `retry` is the dialog's "Try again", the one caller
 * allowed another spawn.
 */
export async function GET(req: Request) {
  const retry = new URL(req.url).searchParams.get("retry") === "1"
  const settings = await readSettings()
  return NextResponse.json(await memoryStatus(settings, { retry }))
}
