/**
 * Who asked. Every API route in this app runs programs, reads the disk and
 * holds the user's keys, and there is no login to hide behind: the server
 * answers `127.0.0.1` and whoever reaches it. The one thing worth refusing is
 * therefore the request the user never made — a page on another origin, open
 * in the same browser, driving this app through the credentials-free fetches
 * a browser is happy to send.
 *
 * Two headers say that, and a page cannot forge either:
 *
 * - `sec-fetch-site` — `same-origin` (the app's own fetches, its `<img>` tags)
 *   and `none` (the address bar) are the app; `cross-site` and `same-site` are
 *   somebody else, and both are refused.
 * - `Origin`, which a browser attaches to every mutating request. When it is
 *   there it has to name this same server.
 *
 * A request carrying neither is *not* a browser — curl, a script, the desktop
 * shell's health probe — and stays allowed. This is a local app, not an auth
 * system: the goal is that a web page cannot reach in, not that the machine's
 * own processes are strangers.
 */

/** Reads never change anything; `Origin` is only required of the rest. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function refusal() {
  return Response.json({ error: "Cross-site request" }, { status: 403 })
}

/**
 * The 403 to return, or `null` when the request may proceed. Call it first in
 * every route that mutates state or hands back file contents:
 *
 *     const refused = crossOriginRefusal(req)
 *     if (refused) return refused
 */
export function crossOriginRefusal(req: Request): Response | null {
  const site = req.headers.get("sec-fetch-site")
  if (site && site !== "same-origin" && site !== "none") return refusal()

  if (SAFE_METHODS.has(req.method.toUpperCase())) return null

  const origin = req.headers.get("origin")
  if (!origin) return null
  // The host the request was actually sent to — the Tauri shell and `next dev`
  // both serve the page from the same `127.0.0.1:<port>` the fetch goes to, so
  // an equal host is exactly what a first-party request looks like.
  const host = req.headers.get("host") ?? safeHost(req.url)
  const from = safeHost(origin)
  return from && from === host ? null : refusal()
}

/** The host of a URL, or "" for anything unparseable (including `null`). */
function safeHost(url: string) {
  try {
    return new URL(url).host
  } catch {
    return ""
  }
}
