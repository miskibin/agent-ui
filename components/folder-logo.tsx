"use client"

import { Folder } from "lucide-react"
import * as React from "react"

import * as api from "@/lib/api-client"
import { normalizeFolderForComparison } from "@/lib/folder-identity"
import type { FolderLogo, FolderLogoMap } from "@/lib/folder-logo"
import { CACHE_FOLDER_LOGOS_KEY, readCache, writeCache } from "@/lib/ui-cache"
import { cn } from "@/lib/utils"

/**
 * The mark beside a sidebar folder section: the project's own icon, or its
 * initials in a colour derived from its path, or the plain folder glyph for a
 * folder that is not a project. `lib/folder-logo.ts` says why; this draws it.
 *
 * One request for the whole sidebar, seeded from the same localStorage
 * snapshot the index is, so the marks are there in the first paint rather than
 * appearing a beat later and shifting every header under the pointer.
 */

/** The last answer, shared by every section and seeded from the cache. */
let logos: FolderLogoMap | null = null
/** Every mounted section, so one fetch repaints all of them. */
const listeners = new Set<() => void>()
/** At most one request in flight, however many sections mount at once. */
let inFlight: Promise<void> | null = null
/** Only the first mount of a page load fetches; the rest read what it wrote. */
let loaded = false

function seed(): FolderLogoMap {
  if (logos) return logos
  logos = readCache<FolderLogoMap>(CACHE_FOLDER_LOGOS_KEY) ?? {}
  return logos
}

function load() {
  if (inFlight) return inFlight
  inFlight = api
    .fetchFolderLogos()
    .then((next) => {
      logos = next
      writeCache(CACHE_FOLDER_LOGOS_KEY, next)
      for (const listener of listeners) listener()
    })
    .catch(() => {
      /* the sidebar keeps the marks it had, or falls back to the glyph */
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/**
 * Re-scans the folders. A chat that just picked a folder the index had never
 * seen has no mark for it until someone asks again — and only that, so the
 * scan is not paid for on every index write.
 */
export function refreshFolderLogos() {
  loaded = true
  void load()
}

function useFolderLogo(cwd: string): FolderLogo | null {
  const key = normalizeFolderForComparison(cwd)
  const subscribe = React.useCallback((onChange: () => void) => {
    listeners.add(onChange)
    if (!loaded) {
      loaded = true
      void load()
    }
    return () => {
      listeners.delete(onChange)
    }
  }, [])
  const snapshot = React.useCallback(() => seed()[key] ?? null, [key])
  // Never rendered on the server — the sidebar is a client component — but
  // `useSyncExternalStore` still wants an answer for the hydration pass, and
  // the cache is exactly what the first paint should show.
  return React.useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function FolderLogoMark({
  cwd,
  className,
}: {
  cwd: string
  className?: string
}) {
  const logo = useFolderLogo(cwd)
  const box = cn(
    "grid size-4 shrink-0 place-items-center overflow-hidden rounded-[3px]",
    className
  )

  if (logo?.kind === "icon") {
    return (
      /* eslint-disable-next-line @next/next/no-img-element -- a data: URL the
         route inlined, not an asset next/image could optimize */
      <img
        src={logo.src}
        alt=""
        aria-hidden
        data-slot="folder-logo"
        data-kind="icon"
        className={cn(box, "object-contain")}
      />
    )
  }

  if (logo?.kind === "monogram") {
    return (
      <span
        aria-hidden
        data-slot="folder-logo"
        data-kind="monogram"
        className={cn(box, "text-[8px] font-semibold tracking-tight")}
        style={{
          /* Only the hue comes from the path. Saturation and lightness are
             fixed here and the ink is `color-mix`ed out of the same hue, so
             every mark carries the same weight in every theme and in both
             modes — a per-project colour must not become a per-project
             contrast problem. */
          backgroundColor: `oklch(0.72 0.13 ${logo.hue} / 0.22)`,
          color: `oklch(0.55 0.15 ${logo.hue})`,
        }}
      >
        {logo.text}
      </span>
    )
  }

  return (
    <Folder
      aria-hidden
      data-slot="folder-logo"
      data-kind="generic"
      className={cn(box, "size-3.5 text-muted-foreground")}
    />
  )
}
