"use client"

import * as React from "react"

import { groupIdForSession } from "@/lib/session-groups"
import type { SessionMeta } from "@/lib/store/types"
import { CACHE_SECTIONS_KEY, readCache, writeCache } from "@/lib/ui-cache"

/**
 * The shell's own state: the collapsible sidebar on desktop, the drawer that
 * slides over the conversation below `md`, which folder sections are folded
 * away, the command palette, and the token that opens one chat's inline
 * rename. None of it touches chat data.
 */
export function useChatNav({
  isDesktop,
  sessionsRef,
}: {
  isDesktop: boolean
  sessionsRef: React.RefObject<SessionMeta[]>
}) {
  const [collapsed, setCollapsed] = React.useState(false)
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

  /** Closing the drawer hands focus back to the button that opened it. */
  const closeDrawer = React.useCallback(() => {
    setMobileNavOpen(false)
    drawerTriggerRef.current?.focus()
  }, [])

  // Escape closes the mobile drawer.
  React.useEffect(() => {
    if (!drawerOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer()
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
    closedSections,
    toggleSection,
    openSection,
    paletteOpen,
    setPaletteOpen,
    openPalette,
    renameRequest,
    startRename,
    drawerOpen,
    drawerTriggerRef,
    closeDrawer,
    closeNav,
    openNav,
    toggleSidebar,
  }
}
