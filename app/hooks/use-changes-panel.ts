"use client"

import * as React from "react"

/**
 * Whether the side panel is showing the chat's changes.
 *
 * The plainest of the three occupants: unlike a file (opened by a click on a
 * path) or a plan (opened by the agent writing one), this one is only ever
 * opened deliberately, from the header's file count. So there is nothing to
 * derive and nothing to dismiss — one flag, cleared when the chat changes,
 * because a review is about the worktree the chat is pointed at.
 */
export function useChangesPanel(activeId: string) {
  const [openFor, setOpenFor] = React.useState<string | null>(null)

  const toggle = React.useCallback(() => {
    setOpenFor((current) => (current === activeId ? null : activeId))
  }, [activeId])

  const close = React.useCallback(() => setOpenFor(null), [])

  return { changesOpen: openFor !== null && openFor === activeId, toggle, close }
}
