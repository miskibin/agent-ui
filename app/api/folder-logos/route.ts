import { NextResponse } from "next/server"

import { normalizeFolderForComparison } from "@/lib/folder-identity"
import type { FolderLogoMap } from "@/lib/folder-logo"
import { folderLogo } from "@/lib/folder-logo-scan"
import { crossOriginRefusal } from "@/lib/request-origin"
import { listSessions } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/folder-logos` — one logo per working folder in the sidebar.
 *
 * Takes no arguments on purpose. Every other file route reads its root back
 * from a stored chat so a page on another origin cannot point it anywhere;
 * this one goes further and never accepts a path at all — it answers for the
 * folders the chat index already names, which is exactly the set the sidebar
 * has rows for. A caller cannot use it to ask whether a folder exists.
 *
 * The whole map comes back in one request rather than one request per section:
 * a sidebar with eight checkouts in it would otherwise open eight connections
 * on every load, and the answer is small enough (`lib/folder-logo-scan.ts`
 * caps each icon) to cache in one localStorage write.
 */
export async function GET(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused

  const sessions = await listSessions().catch(() => [])
  // Keyed by the comparison form, on both sides of the wire: a folder stored
  // as `C:\\repo` by one chat and `c:/repo` by another is one folder, scanned
  // once, and the sidebar looks its group up under the same key rather than
  // under whichever spelling happened to be stored first.
  const folders = new Map<string, string>()
  for (const session of sessions) {
    const cwd = session.cwd?.trim()
    if (!cwd) continue
    const key = normalizeFolderForComparison(cwd)
    if (key && !folders.has(key)) folders.set(key, cwd)
  }

  const resolved = await Promise.all(
    [...folders].map(async ([key, cwd]) => [key, await folderLogo(cwd)] as const)
  )
  const logos: FolderLogoMap = Object.fromEntries(resolved)
  return NextResponse.json({ folders: logos })
}
