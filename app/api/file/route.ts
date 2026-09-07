import { constants as fsConstants } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"

import { NextResponse } from "next/server"

import { isWithinReal } from "@/lib/fs-roots"
import { resolveInRoot } from "@/lib/fs-search"
import { acpAgentKey } from "@/lib/providers/acp"
import { CURSOR_PROVIDER_ID } from "@/lib/providers/cursor"
import { PI_PROVIDER_ID } from "@/lib/providers/pi"
import { crossOriginRefusal } from "@/lib/request-origin"
import { dataDir, readSettings } from "@/lib/settings/server"
import { listSessions } from "@/lib/store/sessions"

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
 * How much of a file decides whether it is text.
 *
 * A single NUL byte in the first megabyte is the whole test — it is what every
 * other tool uses, git included, and it is right for the same reason: a NUL
 * cannot appear in UTF-8 text, and decoding a binary anyway hands the panel a
 * screenful of U+FFFD that looks like a corrupted file rather than a PNG.
 */
const BINARY_SNIFF_BYTES = 1_024 * 1_024

/**
 * `O_NONBLOCK` where the platform has it (Windows does not).
 *
 * Opening a FIFO for reading *blocks until a writer arrives* — forever, if
 * none ever does — and an agent that runs `mkfifo` in its workspace has left
 * one lying there. The flag makes the open return, and the `fstat` on the
 * handle below is what rejects it; a regular file ignores the flag entirely.
 * Doing it on the handle rather than on the path is also what closes the gap
 * between "stat says it is a file" and "open the file".
 */
const O_NONBLOCK =
  typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0

/**
 * The root a path is resolved against — the same directory the provider itself
 * hands its agent, so what the panel opens is what the agent edited.
 *
 * A chat pinned to a folder wins: that is the cwd the run actually used. The
 * caller names the chat, never the folder — the root is read back from the
 * stored session here, so a hand-made request cannot widen what is readable.
 */
async function workspaceRoot(providerId: string, sessionId: string) {
  if (sessionId) {
    const sessions = await listSessions().catch(() => [])
    const cwd = sessions.find((item) => item.id === sessionId)?.cwd?.trim()
    if (cwd) return cwd
  }
  if (providerId === PI_PROVIDER_ID) {
    const settings = await readSettings()
    return settings.providers.pi.workspace?.trim() || process.cwd()
  }
  const acpKey = acpAgentKey(providerId)
  if (acpKey) {
    const settings = await readSettings()
    return settings.providers.acp.agents[acpKey]?.workspace?.trim() || process.cwd()
  }
  // cursorAgent runs in the app's cwd (lib/providers/cursor.ts); so does
  // everything else that has no workspace of its own.
  if (providerId === CURSOR_PROVIDER_ID) return process.cwd()
  return process.cwd()
}

/**
 * `GET /api/file?path=<relative-or-absolute>&provider=<id>&session=<id>` — one
 * file's text
 * for the preview panel.
 *
 * The panel opens on the transcript alone, so this is strictly an enhancement:
 * every failure here is a 4xx the page swallows, never something that blocks
 * the UI. Reads are confined to the provider's workspace, the app's own data
 * directory (`~/.agent-ui`, which holds settings and any keys in them) is
 * refused even when it sits inside that workspace, and a cross-site request is
 * refused before either — file contents are not something another origin gets
 * to ask this app for.
 */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const params = new URL(req.url).searchParams
  const requested = params.get("path")?.trim()
  const providerId = params.get("provider")?.trim() ?? ""
  const sessionId = params.get("session")?.trim() ?? ""

  if (!requested) {
    return NextResponse.json({ error: "No path given" }, { status: 400 })
  }

  // The turbopackIgnore comments keep the tracer from pulling the whole
  // project into the standalone bundle over these dynamic paths.
  const root = path.resolve(
    /*turbopackIgnore: true*/ await workspaceRoot(providerId, sessionId)
  )
  /**
   * An answer names a file the way it thinks of it — a bare `Messages.tsx`, or
   * a `frontend/app/globals.css` that is only a suffix of the real path — so
   * the plain join is a first guess, not the answer. `resolveInRoot` falls
   * back to the folder's own walk and takes the deepest unique suffix; the
   * path it found travels back in the response, because the panel and its
   * "Open in …" menu should name the file that was actually opened.
   */
  const found = await resolveInRoot(root, requested)
  const resolved = found?.absolute ?? path.resolve(root, requested)
  // Only a name the walk had to repair travels back; a path that resolved on
  // its own is echoed exactly as asked, so the panel keeps saying what the
  // tool said.
  const name = found && !found.exact ? found.relative : requested

  // Containment is decided on real paths (`lib/fs-roots`): a symlink under the
  // workspace is otherwise a way straight out of it.
  if (!(await isWithinReal(root, resolved))) {
    return NextResponse.json(
      { error: "That path is outside the workspace" },
      { status: 403 }
    )
  }
  if (await isWithinReal(dataDir(), resolved)) {
    return NextResponse.json(
      { error: "That path is not readable" },
      { status: 403 }
    )
  }

  // Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
  let handle
  try {
    handle = await open(
      /*turbopackIgnore: true*/ resolved,
      fsConstants.O_RDONLY | O_NONBLOCK
    )
  } catch {
    return NextResponse.json({ error: "No such file" }, { status: 404 })
  }
  try {
    const info = await handle.stat()
    // A directory, a FIFO, a socket, a device — none of them are a file the
    // panel can show, and the FIFO is the one that would otherwise hang.
    if (!info.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 404 })
    }
    const wanted = Math.min(info.size, MAX_BYTES)
    const buffer = Buffer.alloc(wanted)
    const { bytesRead } = wanted
      ? await handle.read(buffer, 0, wanted, 0)
      : { bytesRead: 0 }
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      // A typed refusal, not a decode: the panel can say "binary file" instead
      // of rendering a page of replacement characters.
      return NextResponse.json(
        { error: "That file is binary", binary: true, path: name },
        { status: 415 }
      )
    }
    return NextResponse.json({
      path: name,
      content: bytes.toString("utf8"),
      // Too big to send whole: the head is still worth rendering.
      ...(info.size > MAX_BYTES ? { truncated: true } : null),
    })
  } catch {
    return NextResponse.json({ error: "Could not read that file" }, { status: 500 })
  } finally {
    await handle.close().catch(() => {
      /* the read already answered */
    })
  }
}
