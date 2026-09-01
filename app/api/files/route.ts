import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { extname, isAbsolute, resolve, sep } from "node:path"
import { Readable } from "node:stream"

import { NextResponse } from "next/server"

import type { AppSettings } from "@/lib/settings/schema"
import { dataDir, readSettings } from "@/lib/settings/server"
import { listSessions } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/files?path=<absolute path>` — one file from this machine, streamed
 * back on the app's own origin.
 *
 * It exists because a chat cannot show a picture any other way: the page is
 * served over http, and a browser will not fetch a `file://` subresource from
 * it. `lib/local-media` rewrites the image paths in an answer to point here.
 *
 * Two things bound it, neither of them the path:
 *
 * - a cross-site request is refused, so another page in the same browser
 *   cannot use this route to read the disk;
 * - the response is served `nosniff`, sandboxed and non-executable, so a file
 *   that happens to be HTML or SVG cannot run script on the app's origin.
 *
 * The path itself is unrestricted by default — the whole point is showing a
 * chart the agent wrote wherever it wrote it — and `files.anyPath` in settings
 * narrows it to the places the app already works in.
 */

/** Big enough for a screenshot or a short screen recording. */
const MAX_BYTES = 64 * 1024 * 1024

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const raw = url.searchParams.get("path")?.trim() ?? ""
  if (!raw) {
    return NextResponse.json({ error: "path is required" }, { status: 400 })
  }

  // A page on another origin must not be able to probe this machine's disk
  // through the app. Same-origin fetches, the app's own <img> tags and direct
  // navigation all send something other than `cross-site`.
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Cross-site request" }, { status: 403 })
  }

  const path = expandHome(raw)
  if (!isAbsolutePath(path)) {
    return NextResponse.json(
      { error: "path must be absolute" },
      { status: 400 }
    )
  }

  const settings = await readSettings()
  if (!settings.files.anyPath && !(await isWithinKnownRoot(path, settings))) {
    return NextResponse.json(
      {
        error:
          "Reading files outside the app's folders is off — turn on Local files in settings.",
      },
      { status: 403 }
    )
  }

  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) {
    return NextResponse.json({ error: "Not a file" }, { status: 404 })
  }
  if (info.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large" }, { status: 413 })
  }

  const body = Readable.toWeb(
    createReadStream(path)
  ) as unknown as ReadableStream<Uint8Array>

  return new NextResponse(body, {
    headers: {
      "Content-Type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(info.size),
      // Files change under the app's feet; a stale screenshot is worse than a
      // re-read of a local file.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  })
}

/** `~` and `~/foo` — the only shell-ism a hand-typed path really needs. */
function expandHome(input: string): string {
  return input === "~" || input.startsWith("~/") || input.startsWith("~\\")
    ? `${homedir()}${input.slice(1)}`
    : input
}

/**
 * Windows paths reach a POSIX build too — a transcript synced between
 * machines, a path typed by hand — and `node:path` only recognizes the shape
 * of the platform it runs on. Recognizing both keeps the refusal honest: an
 * absolute path that simply is not on this machine gets a 404, not a 400.
 */
function isAbsolutePath(path: string) {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
}

/** The folders the app already reads and writes on the user's behalf. */
async function isWithinKnownRoot(path: string, settings: AppSettings) {
  const sessions = await listSessions().catch(() => [])
  const roots = [
    dataDir(),
    process.cwd(),
    settings.providers.pi.workspace,
    ...sessions.map((session) => session.cwd ?? ""),
  ]
  return roots.some((root) => root.trim() && isWithin(root, path))
}

function isWithin(root: string, path: string) {
  const from = resolve(root)
  const to = resolve(path)
  return to === from || to.startsWith(from.endsWith(sep) ? from : `${from}${sep}`)
}
