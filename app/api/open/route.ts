import { stat } from "node:fs/promises"
import path from "node:path"

import { NextResponse } from "next/server"

import {
  detectOpenTargets,
  openInEditor,
  openTerminal,
  revealInFileManager,
} from "@/lib/open-target"
import { expandHome } from "@/lib/fs-paths"
import { readSettings } from "@/lib/settings/server"
import { getSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/open` — the editors and terminals installed on this machine.
 * `POST /api/open` — open a path in one of them, or reveal it.
 *
 * A relative path is resolved against the chat's working folder, read back
 * from the stored session — the same rule `GET /api/file` follows — so a row
 * that only knows `src/app.ts` still opens the right file. Cross-site requests
 * are refused: launching programs is not something another origin gets to do
 * through the app.
 */

type OpenBody = {
  action?: "editor" | "reveal" | "terminal"
  path?: string
  line?: number
  editor?: string
  terminal?: string
  sessionId?: string
}

export async function GET() {
  return NextResponse.json(await detectOpenTargets())
}

export async function POST(req: Request) {
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Cross-site request" }, { status: 403 })
  }
  let body: OpenBody
  try {
    body = (await req.json()) as OpenBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const requested = body.path?.trim()
  if (!requested) {
    return NextResponse.json({ error: "path is required" }, { status: 400 })
  }

  const session = body.sessionId ? await getSession(body.sessionId) : null
  const root = session?.cwd?.trim() || ""
  const target = path.isAbsolute(expandHome(requested))
    ? expandHome(requested)
    : root
      ? path.resolve(root, requested)
      : ""
  if (!target) {
    return NextResponse.json(
      { error: "That path is relative and this chat has no folder" },
      { status: 400 }
    )
  }

  const info = await stat(/*turbopackIgnore: true*/ target).catch(() => null)
  if (!info) {
    return NextResponse.json({ error: "No such file or folder" }, { status: 404 })
  }
  const isDir = info.isDirectory()
  const settings = await readSettings()

  try {
    if (body.action === "reveal") {
      await revealInFileManager(target, isDir)
      return NextResponse.json({ ok: true })
    }
    if (body.action === "terminal") {
      const opened = await openTerminal({
        terminal: body.terminal || settings.editor.terminal || undefined,
        dir: isDir ? target : path.dirname(target),
      })
      return NextResponse.json({ ok: true, target: opened })
    }
    const opened = await openInEditor({
      editor: body.editor || settings.editor.defaultEditor || undefined,
      path: target,
      line:
        typeof body.line === "number" && body.line > 0
          ? Math.floor(body.line)
          : undefined,
      root: root && !isDir ? root : undefined,
    })
    return NextResponse.json({ ok: true, target: opened })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not open"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
