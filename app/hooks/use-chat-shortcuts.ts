"use client"

import * as React from "react"

import { bindAppShortcuts } from "@/lib/app-shortcuts"
import { isDesktop as isDesktopShell } from "@/lib/desktop"

import type { ChatRefs } from "./use-chat-refs"

/**
 * ⌘N, ⌘B, ⌘⇧[ / ⌘⇧], ⌘1…9, ⌘O and type-to-focus, as one listener.
 *
 * Bound in an effect rather than through a hook that takes the handlers: they
 * read refs, and a closure handed to a function during render is something the
 * compiler rightly refuses to reason about.
 */
export function useChatShortcuts({
  refs,
  handleNewChat,
  toggleSidebar,
  openFolder,
}: {
  refs: ChatRefs
  handleNewChat: () => Promise<void>
  toggleSidebar: () => void
  openFolder: (action: "editor" | "reveal" | "terminal") => void
}) {
  const { activeIdRef, composerRef, orderedIdsRef, selectSessionRef } = refs

  const stepChat = React.useCallback(
    (delta: number) => {
      const ids = orderedIdsRef.current
      if (ids.length === 0) return
      const index = ids.indexOf(activeIdRef.current)
      const next = ids[(index + delta + ids.length) % ids.length]
      if (next && next !== activeIdRef.current) selectSessionRef.current(next)
    },
    [activeIdRef, orderedIdsRef, selectSessionRef]
  )

  React.useEffect(
    () =>
      bindAppShortcuts({
        desktop: isDesktopShell(),
        newChat: () => void handleNewChat(),
        toggleSidebar,
        previousChat: () => stepChat(-1),
        nextChat: () => stepChat(1),
        jumpToChat: (index) => {
          const id = orderedIdsRef.current[index - 1]
          if (id) selectSessionRef.current(id)
        },
        openInEditor: () => openFolder("editor"),
        typeToFocus: () => composerRef.current?.focus(),
      }),
    [
      composerRef,
      handleNewChat,
      openFolder,
      orderedIdsRef,
      selectSessionRef,
      stepChat,
      toggleSidebar,
    ]
  )
}
