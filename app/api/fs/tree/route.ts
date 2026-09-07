import { readdir } from "node:fs/promises"
import path from "node:path"

import { NextResponse } from "next/server"

import { isWithinReal } from "@/lib/fs-roots"
import { SKIP_DIRS } from "@/lib/fs-search"
import { crossOriginRefusal } from "@/lib/request-origin"
import { dataDir } from "@/lib/settings/server"
import { getSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/fs/tree?sessionId=<id>&dir=<relative>` — one level of the chat's
 * working folder, for the file panel's folder browser.
 *
 * One level, never a walk: the tree asks again when a directory is opened, so
 * a monorepo costs one `readdir` per folder the reader actually looks in
 * rather than a full traversal nobody sees. The root is read back from the
 * stored chat exactly the way `/api/file` does it — the client names a chat,
 * never a directory — and containment is decided on real paths
 * (`lib/fs-roots`), so a symlink under the folder is not a way out of it.
 *
 * Its neighbour `/api/fs/list` answers a different question: that one browses
 * the machine for a folder to *point a chat at*, absolute and directories
 * only, before any chat exists. This one is inside a chat's folder and
 * includes its files.
 */

/** Entries past this in one directory are dropped; the level says so. */
const MAX_ENTRIES = 4_000

export type FsTreeEntry = {
  /** Path from the root, `/`-separated. A trailing `/` makes it a directory. */
  path: string
}

export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const params = new URL(req.url).searchParams
  const sessionId = params.get("sessionId")?.trim() ?? ""
  const requested = (params.get("dir") ?? "").trim()

  const session = sessionId ? await getSession(sessionId) : null
  const cwd = session?.cwd?.trim()
  if (!cwd) {
    return NextResponse.json({ error: "That chat has no folder" }, { status: 404 })
  }

  const root = path.resolve(/*turbopackIgnore: true*/ cwd)
  // `""` is the root itself; anything else is joined and then checked, so
  // `../` never survives the containment test below.
  const relative = requested.replace(/\\/g, "/").replace(/^\/+/, "")
  const target = relative ? path.resolve(root, relative) : root

  if (!(await isWithinReal(root, target))) {
    return NextResponse.json(
      { error: "That path is outside the workspace" },
      { status: 403 }
    )
  }
  if (await isWithinReal(dataDir(), target)) {
    return NextResponse.json({ error: "That path is not readable" }, { status: 403 })
  }

  let listing
  try {
    listing = await readdir(/*turbopackIgnore: true*/ target, {
      withFileTypes: true,
    })
  } catch {
    return NextResponse.json({ error: "No such folder" }, { status: 404 })
  }

  const entries: FsTreeEntry[] = []
  let truncated = false
  // Directories first, then files, each alphabetically — the order a tree is
  // read in, and the one `@pierre/trees` keeps.
  const sorted = [...listing].sort((a, b) => {
    const byKind = Number(b.isDirectory()) - Number(a.isDirectory())
    return byKind !== 0 ? byKind : a.name.localeCompare(b.name)
  })
  const prefix = relative ? `${relative.replace(/\/+$/, "")}/` : ""
  for (const entry of sorted) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    if (entry.isDirectory()) {
      // The same list the `@` menu's walk skips: a tree that offers
      // `node_modules` is a tree nobody opens twice.
      if (SKIP_DIRS.has(entry.name)) continue
      entries.push({ path: `${prefix}${entry.name}/` })
    } else if (entry.isFile()) {
      entries.push({ path: `${prefix}${entry.name}` })
    }
  }

  return NextResponse.json({ entries, ...(truncated ? { truncated } : null) })
}
