"use client"

import * as React from "react"

import { groupIdForSession } from "@/lib/session-groups"
import type { SessionMeta } from "@/lib/store/types"
import {
  CACHE_SECTIONS_KEY,
  CACHE_SIDEBAR_WIDTH_KEY,
  readCache,
  writeCache,
} from "@/lib/ui-cache"

/**
 * The shell's own state: the collapsible sidebar on desktop, how wide it is,
 * the drawer that slides over the conversation below `md`, which folder
 * sections are folded away, the command palette, and the token that opens one
 * chat's inline rename. None of it touches chat data.
 */

/**
 * The width the rail was left at, read during the first render rather than
 * after it.
 *
 * Every other snapshot here is picked up in a microtask after mount, which is
 * fine for something that only changes what is *inside* the panel. This one
 * changes the panel's own width, and a frame at 290px before it jumps is the
 * flash the seeding exists to avoid — the rail writes the value in a layout
 * effect, so nothing is painted at the default first. A prerender has no
 * storage to read and simply gets 0.
 */
function readSidebarWidth() {
  const stored = readCache<number>(CACHE_SIDEBAR_WIDTH_KEY)
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0
    ? stored
    : 0
}

export function useChatNav({
  isDesktop,
  sessionsRef,
}: {
  isDesktop: boolean
  sessionsRef: React.RefObject<SessionMeta[]>
}) {
  const [collapsed, setCollapsed] = React.useState(false)
  /** Pixels; 0 = never resized, and the panel keeps its default width. */
  const [sidebarWidth, setSidebarWidth] = React.useState(readSidebarWidth)
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)
  /** Sections the user closed. Absent id = open, so a new folder shows up. */
  const [closedSections, setClosedSections] = React.useState<
    Record<string, boolean>
  >({})
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  /** Bumped to open the sidebar's inline rename for one chat. */
  const [renameRequest, setRenameRequest] = React.useState({
    id: "",
    token: 0,
  })

  const drawerTriggerRef = React.useRef<HTMLButtonElement>(null)
  const drawerRef = React.useRef<HTMLDivElement>(null)
  const drawerOpen = mobileNavOpen && !isDesktop

  // Same microtask trick as the sidebar seed: read the closed sections after
  // mount without a setState in the effect body.
  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      const cached = readCache<Record<string, boolean>>(CACHE_SECTIONS_KEY)
      if (cached) setClosedSections(cached)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const sectionsDirtyRef = React.useRef(false)
  React.useEffect(() => {
    // The seed itself must not write back — only a real toggle does.
    if (!sectionsDirtyRef.current) return
    writeCache(CACHE_SECTIONS_KEY, closedSections)
  }, [closedSections])

  const toggleSection = React.useCallback((id: string) => {
    sectionsDirtyRef.current = true
    setClosedSections((prev) => {
      const next = { ...prev }
      if (next[id]) delete next[id]
      else next[id] = true
      return next
    })
  }, [])

  const openSection = React.useCallback((id: string) => {
    setClosedSections((prev) => {
      if (!prev[id]) return prev
      sectionsDirtyRef.current = true
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  /**
   * The rail reports a settled width — on release, on the double-click reset
   * and on every keyboard step, never per frame — and this is where it is
   * kept. The panel is already at that width by the time this runs, so the
   * state is for the *next* mount, not for this one.
   */
  const saveSidebarWidth = React.useCallback((width: number) => {
    setSidebarWidth(width)
    writeCache(CACHE_SIDEBAR_WIDTH_KEY, width)
  }, [])

  /** Closing the drawer hands focus back to the button that opened it. */
  const closeDrawer = React.useCallback(() => {
    setMobileNavOpen(false)
    requestAnimationFrame(() => drawerTriggerRef.current?.focus())
  }, [])

  // The mobile sidebar is a modal drawer: focus enters it, cycles inside it,
  // and returns to the trigger when Escape or the backdrop closes it.
  React.useEffect(() => {
    if (!drawerOpen) return
    const drawer = drawerRef.current
    const focusable = () =>
      drawer
        ? [...drawer.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )].filter(
            (element) =>
              element.getClientRects().length > 0 && !element.closest('[inert]')
          )
        : []
    focusable()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDrawer()
        return
      }
      if (event.key !== "Tab") return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        drawer?.focus()
        return
      }
      const first = items[0]
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [closeDrawer, drawerOpen])

  /** Palette → the sidebar's inline rename input for that chat. */
  const startRename = React.useCallback(
    (id: string) => {
      if (isDesktop) setCollapsed(false)
      else setMobileNavOpen(true)
      const session = sessionsRef.current.find((item) => item.id === id)
      // The rename input has to be on screen: open the section holding it.
      if (session) openSection(groupIdForSession(session))
      setRenameRequest((prev) => ({ id, token: prev.token + 1 }))
    },
    [isDesktop, openSection, sessionsRef]
  )

  /** ⌘B, and the sidebar's own collapse control. */
  const toggleSidebar = React.useCallback(() => {
    if (isDesktop) setCollapsed((current) => !current)
    else setMobileNavOpen((current) => !current)
  }, [isDesktop])

  /** Picking a chat just dismisses the drawer — focus follows the click. */
  const closeNav = React.useCallback(() => setMobileNavOpen(false), [])
  const openNav = React.useCallback(() => setMobileNavOpen(true), [])
  const openPalette = React.useCallback(() => setPaletteOpen(true), [])

  return {
    collapsed,
    setCollapsed,
    sidebarWidth,
    saveSidebarWidth,
    closedSections,
    toggleSection,
    openSection,
    paletteOpen,
    setPaletteOpen,
    openPalette,
    renameRequest,
    startRename,
    drawerOpen,
    drawerRef,
    drawerTriggerRef,
    closeDrawer,
    closeNav,
    openNav,
    toggleSidebar,
  }
}
