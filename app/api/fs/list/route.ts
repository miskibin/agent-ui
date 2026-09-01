import type { Dirent } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"

import { NextResponse } from "next/server"

import { defaultBrowseRoot, expandHome } from "@/lib/fs-paths"
import type { FolderEntry, FolderListing } from "@/lib/folder"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/*
 * The `turbopackIgnore` comments below are the same opt-out `lib/cursor-agent`
 * uses on its spawn calls: the paths here come from the user at runtime, and
 * without them the static tracer assumes the whole project is a data directory
 * and bundles every source file into the standalone server.
 */

/** A home directory with a few thousand children is not worth rendering. */
const MAX_ENTRIES = 400
/** `.git` is probed for the visible head of the list, not for all of it. */
const MAX_GIT_PROBES = 150

/**
 * Lists the sub-directories of one folder, for the picker's built-in browser.
 *
 * Deliberately forgiving: asked for a path that does not exist — which is what
 * a half-typed one looks like — it walks up to the nearest ancestor that does
 * and reports which folder it actually listed, so the client can filter that
 * listing by the leftover segment instead of showing nothing while the user
 * types.
 *
 * Only directories come back. The picker chooses a working folder; a file is
 * never an answer, and listing every node_modules entry alongside would bury
 * the ones that are.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("path")?.trim() ?? ""
  const requested = raw ? expandHome(raw) : defaultBrowseRoot()

  const dir = await nearestDirectory(requested)
  if (!dir) {
    return NextResponse.json<FolderListing>({
      path: requested,
      parent: null,
      entries: [],
      truncated: false,
    })
  }

  let names: Dirent[]
  try {
    names = await readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true })
  } catch {
    // Exists but unreadable (permissions) — an empty folder, not an error.
    return NextResponse.json<FolderListing>({
      path: dir,
      parent: parentOf(dir),
      entries: [],
      truncated: false,
    })
  }

  const dirs: { name: string; hidden: boolean }[] = []
  for (const entry of names) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (
      entry.isSymbolicLink() &&
      !(await isDirectory(join(/*turbopackIgnore: true*/ dir, entry.name)))
    ) {
      continue
    }
    dirs.push({ name: entry.name, hidden: entry.name.startsWith(".") })
  }

  // Visible folders first, then dotfiles: both are reachable, but a project
  // is almost never the one that starts with a dot.
  dirs.sort(
    (a, b) =>
      Number(a.hidden) - Number(b.hidden) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  )

  const truncated = dirs.length > MAX_ENTRIES
  const shown = truncated ? dirs.slice(0, MAX_ENTRIES) : dirs

  const entries: FolderEntry[] = await Promise.all(
    shown.map(async (entry, index) => {
      const path = join(/*turbopackIgnore: true*/ dir, entry.name)
      return {
        name: entry.name,
        path,
        hidden: entry.hidden,
        isGitRepo:
          index < MAX_GIT_PROBES
            ? await isDirectory(join(/*turbopackIgnore: true*/ path, ".git"))
            : false,
      }
    })
  )

  return NextResponse.json<FolderListing>({
    path: dir,
    parent: parentOf(dir),
    entries,
    truncated,
  })
}

/** `/home/me/half-typed` → `/home/me`. Absolute paths only. */
async function nearestDirectory(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null
  let current = path
  for (;;) {
    if (await isDirectory(current)) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function parentOf(path: string): string | null {
  const parent = dirname(path)
  return parent === path ? null : parent
}

async function isDirectory(path: string) {
  return stat(path)
    .then((info) => info.isDirectory())
    .catch(() => false)
}
