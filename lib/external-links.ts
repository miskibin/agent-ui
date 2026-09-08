/**
 * Which anchors leave the app.
 *
 * A link in an answer is a link: `components/ui/message-markdown.tsx` turns
 * Streamdown's "Open external link?" interstitial off, so an absolute href
 * renders as a real `<a target="_blank">` and a browser tab opens it on the
 * first click. Inside the desktop shell that anchor has nowhere to go —
 * `target="_blank"` asks the webview for a window it will not make, and the
 * click does nothing at all — so the shell intercepts it and hands the URL to
 * the system browser instead (`components/external-links.tsx`).
 *
 * This half is pure and free of the DOM so it can be unit tested: what counts
 * as a URL worth leaving for, and which clicks are the browser's own business.
 */

/**
 * Schemes that mean "not this app". `http`/`https` are the answer's citations;
 * `mailto` and `tel` hand off to a mail client or a phone, which the webview
 * cannot do either.
 *
 * Deliberately a list rather than "anything with a scheme": `file:`, `data:`
 * and `blob:` are the app's own plumbing, and `agent-ui://` is the shell's.
 */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"])

/**
 * The href as something to open, or null.
 *
 * `href` on an anchor element is already absolute — the browser resolved it
 * against the page — so an in-page `#anchor` and a route the app navigates to
 * itself arrive here as this origin and are refused, which is what keeps the
 * interception to links that genuinely leave.
 */
export function externalUrl(href: string, origin: string): string | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return null
  // Same-origin http(s) is the app's own routing — /settings, a file the panel
  // links to — and must stay in the window it is already in.
  if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === origin) {
    return null
  }
  return url.href
}

/** The modifier-and-button half of a click the app may claim. */
export type ClickIntent = {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}

/**
 * True for a plain left click and nothing else.
 *
 * ⌘/Ctrl-click, shift-click and middle-click are the user asking the *browser*
 * for a new tab or window, and alt-click is a download. Claiming those would
 * take away the reasons an anchor is better than a button in the first place —
 * and a click something else already handled is not ours to re-handle.
 */
export function isPlainClick(event: ClickIntent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  )
}
