import "server-only"

import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { normalizeFolderForComparison } from "@/lib/folder-identity"
import { folderHue, folderMonogram, type FolderLogo } from "@/lib/folder-logo"

/**
 * Finding a folder's logo on disk — the reading half of `lib/folder-logo.ts`.
 *
 * A project that has a face already put it somewhere conventional: a Next app
 * writes `app/favicon.ico`, a Vite one `public/favicon.svg`, a Tauri one
 * `src-tauri/icons/`, a library its `.github/logo.png`. So this looks in those
 * places rather than asking for configuration, and answers with a monogram
 * when it finds nothing — a folder is never left without a mark.
 *
 * Every read is best-effort and bounded. This runs for every folder in the
 * sidebar on a page load, and a sidebar that waits on a filesystem walk is a
 * sidebar that is late: nothing here recurses, and each candidate is one
 * `stat`-and-`read` of a path built up front.
 */

/**
 * Where a project keeps its icon, best first.
 *
 * Ordered by how deliberate the file is rather than by how pretty it is: a
 * `public/logo.svg` is the mark the project chose to show people, while
 * `favicon.ico` is often a framework's untouched default — so the logos come
 * before the favicons within each directory. Vector before raster, because a
 * 16px mark on a retina display is the whole point.
 */
const CANDIDATES = [
  "public/logo.svg",
  "public/logo.png",
  "public/icon.svg",
  "public/icon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "public/apple-touch-icon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/favicon.ico",
  "app/apple-icon.png",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/favicon.ico",
  "static/logo.svg",
  "static/logo.png",
  "static/favicon.svg",
  "static/favicon.ico",
  "static/favicon.png",
  "assets/logo.svg",
  "assets/logo.png",
  "assets/icon.svg",
  "assets/icon.png",
  "resources/icon.png",
  "src-tauri/icons/128x128@2x.png",
  "src-tauri/icons/128x128.png",
  "docs/public/logo.svg",
  "docs/public/favicon.ico",
  ".github/logo.svg",
  ".github/logo.png",
  "logo.svg",
  "logo.png",
  "icon.svg",
  "icon.png",
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
]

/** Extension → what a `data:` URL has to call it. */
const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

/**
 * The cap on one inlined icon.
 *
 * These are base64'd into a JSON answer the sidebar keeps in localStorage, and
 * the budget there is the whole map rather than one entry. 64 KB is a generous
 * favicon and a small logo; a 2 MB press-kit PNG named `logo.png` is not a
 * sidebar glyph and is skipped rather than shrunk, which would need a decoder.
 */
const MAX_ICON_BYTES = 64 * 1024

/**
 * How long a resolved logo is trusted.
 *
 * A project's icon changes about never, and the cost of being a few minutes
 * stale is a stale 16px mark. The cost of not caching is re-walking every
 * folder in the sidebar on every page load and every window focus.
 */
const TTL_MS = 5 * 60_000

type CacheEntry = { at: number; logo: FolderLogo }

const cache = new Map<string, CacheEntry>()

/**
 * The folders that are not projects: the home directory, everything above it
 * (`/home`, `/`, `C:\`), and the standard user folders directly inside it.
 *
 * A chat opened in one of these is a chat with no project — "just show generic
 * dir favicon then" — and a monogram there would invent an identity for
 * somebody's home directory.
 */
const USER_FOLDERS = new Set([
  "desktop",
  "documents",
  "downloads",
  "music",
  "pictures",
  "videos",
  "public",
  "templates",
])

function isGenericFolder(path: string): boolean {
  const home = homedir()
  const key = normalizeFolderForComparison(path)
  if (!key) return true
  if (key === normalizeFolderForComparison(home)) return true
  // An ancestor of home — `/home`, `/Users`, `/`, `C:\`. Walking up from home
  // rather than pattern-matching keeps this right on every platform.
  for (
    let current = dirname(home), previous = home;
    current !== previous;
    previous = current, current = dirname(current)
  ) {
    if (key === normalizeFolderForComparison(current)) return true
  }
  const parent = dirname(resolve(path))
  return (
    normalizeFolderForComparison(parent) === normalizeFolderForComparison(home) &&
    USER_FOLDERS.has(basename(path).toLowerCase())
  )
}

/** The candidate as a `data:` URL, or null if it is missing or too big. */
async function readIcon(folder: string, relative: string): Promise<string | null> {
  const extension = relative.slice(relative.lastIndexOf("."))
  const mime = MIME[extension]
  if (!mime) return null
  const path = join(folder, relative)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size === 0 || info.size > MAX_ICON_BYTES) return null
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return null
  return `data:${mime};base64,${bytes.toString("base64")}`
}

/** The fallback mark: this folder's own initials, coloured by its own path. */
function monogram(path: string): FolderLogo {
  return {
    kind: "monogram",
    text: folderMonogram(basename(resolve(path))),
    hue: folderHue(normalizeFolderForComparison(path)),
  }
}

/**
 * One folder's logo. Cached for {@link TTL_MS}; a folder that has gone away
 * answers `generic` rather than throwing, because the sidebar still has a row
 * for it and an empty square is worse than a folder glyph.
 */
export async function folderLogo(path: string): Promise<FolderLogo> {
  const key = normalizeFolderForComparison(path)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.logo

  const logo = await resolveFolderLogo(path)
  cache.set(key, { at: Date.now(), logo })
  return logo
}

async function resolveFolderLogo(path: string): Promise<FolderLogo> {
  if (isGenericFolder(path)) return { kind: "generic" }
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) return { kind: "generic" }
  for (const candidate of CANDIDATES) {
    const src = await readIcon(path, candidate)
    if (src) return { kind: "icon", src }
  }
  return monogram(path)
}

/** Drops every cached answer. The tests' way back to a cold scan. */
export function clearFolderLogoCache() {
  cache.clear()
}
