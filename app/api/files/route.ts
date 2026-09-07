import { constants as fsConstants } from "node:fs"
import { open } from "node:fs/promises"
import { homedir } from "node:os"
import { extname, isAbsolute } from "node:path"
import { Readable } from "node:stream"

import { NextResponse } from "next/server"

import { isWithinKnownRoot, isWithinReal } from "@/lib/fs-roots"
import {
  IMAGE_HEADER_BYTES,
  readImageDimensions,
} from "@/lib/image-dimensions"
import { crossOriginRefusal } from "@/lib/request-origin"
import { dataDir, readSettings } from "@/lib/settings/server"

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
 * Three things bound it, none of them the path:
 *
 * - a cross-site request is refused, so another page in the same browser
 *   cannot use this route to read the disk;
 * - the app's own data directory is refused outright, `files.anyPath` or not:
 *   it holds settings.json, and settings.json holds the user's API keys;
 * - the response is served `nosniff`, sandboxed and non-executable, so a file
 *   that happens to be HTML or SVG cannot run script on the app's origin.
 *
 * The path itself is unrestricted by default — the whole point is showing a
 * chart the agent wrote wherever it wrote it — and `files.anyPath` in settings
 * narrows it to the places the app already works in.
 */

/** Big enough for a screenshot or a short screen recording. */
const MAX_BYTES = 64 * 1024 * 1024

/**
 * `O_NONBLOCK` where the platform has it (Windows does not). Opening a FIFO
 * for reading blocks until somebody writes to it, and an agent that ran
 * `mkfifo` has left one in the workspace; with the flag the open returns and
 * the `fstat` on the handle rejects it. Statting the *handle* rather than the
 * path is also what closes the gap between the check and the open.
 */
const O_NONBLOCK =
  typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0

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
  // navigation are the only ones that get through.
  const refused = crossOriginRefusal(req)
  if (refused) return refused

  const path = expandHome(raw)
  if (!isAbsolutePath(path)) {
    return NextResponse.json(
      { error: "path must be absolute" },
      { status: 400 }
    )
  }

  // Same refusal `POST /api/open` makes, and for the same reason: the data
  // directory is one of the app's own folders, so the `anyPath` check below
  // would happily wave it through.
  if (await isWithinReal(dataDir(), path)) {
    return NextResponse.json({ error: "That path is not readable" }, { status: 403 })
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

  // Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
  const handle = await open(
    /*turbopackIgnore: true*/ path,
    fsConstants.O_RDONLY | O_NONBLOCK
  ).catch(() => null)
  if (!handle) {
    return NextResponse.json({ error: "Not a file" }, { status: 404 })
  }
  const info = await handle.stat().catch(() => null)
  const close = () =>
    handle.close().catch(() => {
      /* nothing left to do about it */
    })
  if (!info?.isFile()) {
    await close()
    return NextResponse.json({ error: "Not a file" }, { status: 404 })
  }
  if (info.size > MAX_BYTES) {
    await close()
    return NextResponse.json({ error: "File too large" }, { status: 413 })
  }

  const contentType =
    CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
  const dimensions = contentType.startsWith("image/")
    ? await readImageHeader(path, info.size)
    : null

  // The stream owns the handle from here: it closes it when it ends, and a
  // cancelled response destroys the stream, which does the same.
  const body = Readable.toWeb(
    handle.createReadStream()
  ) as unknown as ReadableStream<Uint8Array>

  return new NextResponse(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(info.size),
      // What size box to reserve for this picture. A component that reads
      // these before the bytes arrive lays the image out once, instead of
      // reflowing the answer around it the moment it decodes.
      ...(dimensions
        ? {
            "X-Image-Width": String(dimensions.width),
            "X-Image-Height": String(dimensions.height),
          }
        : null),
      // Files change under the app's feet; a stale screenshot is worse than a
      // re-read of a local file.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  })
}

/**
 * The dimensions out of the file's own header, or null.
 *
 * Only the head is read — a few kilobytes, never the file — so this stays a
 * cheap thing to do on the way to a streamed response: the body still streams
 * from disk, and a 40 MB screenshot is not buffered to learn how wide it is.
 * Everything unreadable or unrecognized is null, and the response simply goes
 * out without the headers, exactly as it always did.
 */
async function readImageHeader(path: string, size: number) {
  const length = Math.min(size, IMAGE_HEADER_BYTES)
  if (length <= 0) return null
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, "r")
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return readImageDimensions(buffer.subarray(0, bytesRead))
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
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

