"use client"

import * as React from "react"

/**
 * The composer is an island: once a chat has messages it floats over the
 * transcript instead of sitting in a full-width band under it, so the
 * conversation keeps running to the bottom of the window and slides beneath
 * it. That only works if the list reserves exactly as much room as the island
 * takes — and it grows and shrinks, with a todo line, with chips, with a
 * textarea that has been typed into. One observer writes the measured height
 * onto the pane and the list pads by that variable.
 *
 * Callback refs, not a mount-only effect: the pane lives inside a resizable
 * split that remounts its children when the side panel opens, and an effect
 * with `[]` keeps writing onto the node that just unmounted. The list then
 * falls back to `7rem` and a todo or plan bar reads as overlapping the last
 * turn.
 *
 * `borderBoxSize` / `offsetHeight`, not a bounding rect: the pane may live
 * inside the `--ui-scale` wrapper, where a rect comes back in visual pixels
 * while the padding it feeds is resolved in the element's own — the two would
 * disagree by exactly the zoom factor.
 */
export function useComposerHeight() {
  const paneNode = React.useRef<HTMLDivElement | null>(null)
  const composerNode = React.useRef<HTMLDivElement | null>(null)
  const observerRef = React.useRef<ResizeObserver | null>(null)

  const bind = React.useCallback(() => {
    observerRef.current?.disconnect()
    observerRef.current = null
    const pane = paneNode.current
    const composer = composerNode.current
    if (!pane || !composer) {
      pane?.style.removeProperty("--composer-height")
      return
    }
    if (typeof ResizeObserver === "undefined") {
      pane.style.setProperty(
        "--composer-height",
        `${Math.round(composer.offsetHeight)}px`
      )
      return
    }
    const apply = (height: number) => {
      pane.style.setProperty("--composer-height", `${Math.round(height)}px`)
    }
    apply(composer.offsetHeight)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      /* FrozenArray, not Array — `[0]` still works, `Array.isArray` does not. */
      apply(entry.borderBoxSize?.[0]?.blockSize ?? composer.offsetHeight)
    })
    observer.observe(composer)
    observerRef.current = observer
  }, [])

  const chatPaneRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      paneNode.current = node
      bind()
    },
    [bind]
  )
  const composerBoxRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      composerNode.current = node
      bind()
    },
    [bind]
  )

  React.useEffect(() => () => observerRef.current?.disconnect(), [])

  return { chatPaneRef, composerBoxRef }
}
