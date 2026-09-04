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
import { resolveInRoot } from "@/lib/fs-search"
import { isWithinKnownRoot, isWithinReal } from "@/lib/fs-roots"
import { crossOriginRefusal } from "@/lib/request-origin"
import type { AppSettings } from "@/lib/settings/schema"
import { dataDir, readSettings } from "@/lib/settings/server"
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
 *
 * The target is what a click chose, but the path may have been named by an
 * answer — an image an agent pointed at, a chip it wrote — so the same
 * `files.anyPath` switch that narrows `/api/files` narrows this: off, only the
 * app's own folders open. The data directory never does, either way: a
 * terminal there is a terminal in the folder holding the API keys.
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
  const refused = crossOriginRefusal(req)
  if (refused) return refused
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
  const expanded = expandHome(requested)
  /**
   * `path.resolve` is what normalizes the separators, and it has to run on an
   * absolute path too: the client joins a chat folder with a path an answer
   * wrote, so `C:\\repo` + `app/globals.css` arrives mixed — and Explorer's
   * `/select,` silently does nothing with a forward slash in it.
   */
  let target = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : root
      ? path.resolve(root, requested)
      : ""
  if (!target) {
    return NextResponse.json(
      { error: "That path is relative and this chat has no folder" },
      { status: 400 }
    )
  }

  const settings = await readSettings()
  const denied = await refuseTarget(target, settings)
  if (denied) return denied

  let info = await stat(/*turbopackIgnore: true*/ target).catch(() => null)
  if (!info && root) {
    // The name came from an answer, not from a tool: a bare `Messages.tsx` or
    // a path that is only a suffix of the real one. Same repair the preview
    // panel does — the folder's own walk, deepest unique suffix wins.
    const found = await resolveInRoot(root, requested)
    if (found) {
      // The walk can land anywhere under the chat's folder — the data
      // directory included, when the chat is pinned at home — so the repaired
      // path has to pass the same two checks the requested one did.
      const refusedRepair = await refuseTarget(found.absolute, settings)
      if (refusedRepair) return refusedRepair
      target = found.absolute
      info = await stat(/*turbopackIgnore: true*/ target).catch(() => null)
    }
  }
  if (!info) {
    return NextResponse.json({ error: "No such file or folder" }, { status: 404 })
  }
  const isDir = info.isDirectory()

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

/**
 * The two refusals every path this route opens has to survive — factored out
 * because the repaired path is a *different* path, and running these once on
 * the one that was asked for says nothing about the one that gets launched.
 */
async function refuseTarget(target: string, settings: AppSettings) {
  if (await isWithinReal(dataDir(), target)) {
    return NextResponse.json(
      { error: "The app's data folder cannot be opened from a chat" },
      { status: 403 }
    )
  }
  if (!settings.files.anyPath && !(await isWithinKnownRoot(target, settings))) {
    return NextResponse.json(
      {
        error:
          "Opening paths outside the app's folders is off — turn on Local files in settings.",
      },
      { status: 403 }
    )
  }
  return null
}
