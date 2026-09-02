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
 * `borderBoxSize`, not a bounding rect: the pane may live inside the
 * `--ui-scale` wrapper, where a rect comes back in visual pixels while the
 * padding it feeds is resolved in the element's own — the two would disagree
 * by exactly the zoom factor.
 */
export function useComposerHeight() {
  const chatPaneRef = React.useRef<HTMLDivElement>(null)
  /** The composer's box, for its height; the handle is `refs.composerRef`. */
  const composerBoxRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const pane = chatPaneRef.current
    const composer = composerBoxRef.current
    if (!pane || !composer || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const height =
        entry.borderBoxSize?.[0]?.blockSize ??
        entry.target.getBoundingClientRect().height
      pane.style.setProperty("--composer-height", `${Math.round(height)}px`)
    })
    observer.observe(composer)
    return () => observer.disconnect()
  }, [])

  return { chatPaneRef, composerBoxRef }
}
