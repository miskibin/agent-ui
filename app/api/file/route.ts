import { open, readFile, stat } from "node:fs/promises"
import path from "node:path"

import { NextResponse } from "next/server"

import { CURSOR_PROVIDER_ID } from "@/lib/providers/cursor"
import { PI_PROVIDER_ID } from "@/lib/providers/pi"
import { dataDir, readSettings } from "@/lib/settings/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Past this a file is not something the preview panel can usefully render, and
 * shipping it would only stall the browser. Bigger files come back with the
 * first `MAX_BYTES` and `truncated: true` — the panel still shows the head
 * rather than failing outright.
 */
const MAX_BYTES = 1_536_000 // 1.5 MB

/**
 * The root a path is resolved against — the same directory the provider itself
 * hands its agent, so what the panel opens is what the agent edited.
 */
async function workspaceRoot(providerId: string) {
  if (providerId === PI_PROVIDER_ID) {
    const settings = await readSettings()
    return settings.providers.pi.workspace?.trim() || process.cwd()
  }
  // cursorAgent runs in the app's cwd (lib/providers/cursor.ts); so does
  // everything else that has no workspace of its own.
  if (providerId === CURSOR_PROVIDER_ID) return process.cwd()
  return process.cwd()
}

/** `child` is `parent` itself or lives underneath it. */
function contains(parent: string, child: string) {
  return child === parent || child.startsWith(parent + path.sep)
}

/**
 * `GET /api/file?path=<relative-or-absolute>&provider=<id>` — one file's text
 * for the preview panel.
 *
 * The panel opens on the transcript alone, so this is strictly an enhancement:
 * every failure here is a 4xx the page swallows, never something that blocks
 * the UI. Reads are confined to the provider's workspace, and the app's own
 * data directory (`~/.agent-ui`, which holds settings and any keys in them) is
 * refused even when it sits inside that workspace.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams
  const requested = params.get("path")?.trim()
  const providerId = params.get("provider")?.trim() ?? ""

  if (!requested) {
    return NextResponse.json({ error: "No path given" }, { status: 400 })
  }

  // The turbopackIgnore comments keep the tracer from pulling the whole
  // project into the standalone bundle over these dynamic paths.
  const root = path.resolve(
    /*turbopackIgnore: true*/ await workspaceRoot(providerId)
  )
  const resolved = path.resolve(root, requested)

  if (!contains(root, resolved)) {
    return NextResponse.json(
      { error: "That path is outside the workspace" },
      { status: 403 }
    )
  }
  if (contains(path.resolve(dataDir()), resolved)) {
    return NextResponse.json(
      { error: "That path is not readable" },
      { status: 403 }
    )
  }

  let size: number
  try {
    const info = await stat(/*turbopackIgnore: true*/ resolved)
    if (!info.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 404 })
    }
    size = info.size
  } catch {
    return NextResponse.json({ error: "No such file" }, { status: 404 })
  }

  try {
    if (size <= MAX_BYTES) {
      const content = await readFile(/*turbopackIgnore: true*/ resolved, "utf8")
      return NextResponse.json({ path: requested, content })
    }
    // Too big to send whole: hand back the head so the panel still renders.
    const handle = await open(/*turbopackIgnore: true*/ resolved, "r")
    try {
      const buffer = Buffer.alloc(MAX_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES, 0)
      return NextResponse.json({
        path: requested,
        content: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated: true,
      })
    } finally {
      await handle.close()
    }
  } catch {
    return NextResponse.json({ error: "Could not read that file" }, { status: 500 })
  }
}
