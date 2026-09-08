"use client"

import * as React from "react"

import { isDesktop, openExternal } from "@/lib/desktop"
import { externalUrl, isPlainClick } from "@/lib/external-links"

/**
 * Renders nothing: makes every external link in the desktop shell open in the
 * system browser, on the first click.
 *
 * A link in an answer is an ordinary `<a target="_blank">` — the vendored
 * markdown renderer turns Streamdown's "Open external link?" interstitial off,
 * so a browser tab opens the URL with no dialog in the way. The shell is where
 * that breaks: `target="_blank"` asks the webview for a window it will never
 * make, so the click lands on nothing at all and the link looks broken.
 *
 * One delegated listener on the document is the whole fix, and the reason it is
 * one rather than a prop on the renderer is that links are everywhere — an
 * answer, a folder header's pull request, the settings panel, a toast. A
 * capturing listener would be the wrong instrument (it would outrank a
 * component that wants the click for itself); this one bubbles, so anything
 * that called `preventDefault` on the way up has already won.
 *
 * A no-op in a browser tab, where the anchor already works and the browser's
 * own new-tab behaviour is nobody else's to take.
 */
export function ExternalLinks() {
  React.useEffect(() => {
    if (!isDesktop()) return
    const onClick = (event: MouseEvent) => {
      if (!isPlainClick(event)) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest("a[href]")
      if (!(anchor instanceof HTMLAnchorElement)) return
      // `download` means "save it", which the shell has no browser to do it
      // with — leave that click alone rather than opening the file in one.
      if (anchor.hasAttribute("download")) return
      const url = externalUrl(anchor.href, window.location.origin)
      if (!url) return
      event.preventDefault()
      void openExternal(url)
    }
    document.addEventListener("click", onClick)
    return () => document.removeEventListener("click", onClick)
  }, [])

  return null
}
