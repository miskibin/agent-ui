/**
 * Local files an answer points at.
 *
 * An agent that just wrote `wykres.png` links it the way it thinks of it — as
 * a path on this machine: `![](C:\Users\me\wykres.png)`. A browser cannot load
 * that: the page is served over http, and `file://` is not a subresource it
 * will fetch, whatever the markdown says. So the path is rewritten to a URL on
 * the app's own origin, `GET /api/files`, which reads the file and serves it
 * back. Percent-encoding it also fixes the other half of the problem — a path
 * with a space in it (`Agent UI`) is not a markdown link target at all.
 *
 * Only image targets are rewritten. A plain link to a file stays a link: it
 * would navigate away from the chat, and nothing about that is an improvement.
 */

/** Anything that names a place on this machine rather than a URL. */
const LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])/

/** `![alt](target)` — deliberately looser than CommonMark, see above. */
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g

/** A trailing `"title"` / `'title'`, which is part of the target group above. */
const TITLE = /^(.*?)\s+("[^"]*"|'[^']*')$/

/** The route's own prefix — see the idempotence note on `linkLocalImages`. */
const FILE_ROUTE = "/api/files?path="
const FILE_ROUTE_PATTERN = /\/api\/files\?path=([^)\s"']+)/g

export function localFileUrl(path: string) {
  return `${FILE_ROUTE}${encodeURIComponent(path)}`
}

export function isLocalPath(target: string) {
  return LOCAL_PATH.test(target)
}

/**
 * Rewrites the image targets in one markdown string that name a local file.
 * Everything else — `http(s)`, `data:`, relative paths, links that merely look
 * like one — is returned untouched, and the string identity is preserved when
 * nothing matches so memoized rows do not re-render for a no-op.
 *
 * Idempotent, and it has to be: the streaming reducer re-runs this over the
 * accumulated text on every delta, so a target already pointing at the route
 * must be left exactly as it is rather than encoded a second time.
 */
export function linkLocalImages(markdown: string): string {
  if (!markdown.includes("![")) return markdown
  return markdown.replace(MARKDOWN_IMAGE, (whole, alt: string, raw: string) => {
    let target = raw.trim()
    const titled = TITLE.exec(target)
    const title = titled ? ` ${titled[2]}` : ""
    if (titled) target = titled[1].trim()
    // A target wrapped in <> is how markdown carries a space today; either way
    // it is the path we want.
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1).trim()
    }
    if (!target || target.startsWith(FILE_ROUTE)) return whole
    if (!isLocalPath(target)) return whole
    return `![${alt}](${localFileUrl(target)}${title})`
  })
}

/**
 * The same route, for a path a *tool* named rather than an answer's markdown.
 * A tool row usually carries an absolute path; a relative one only means
 * anything against the folder the turn ran in, so it is joined with the chat's
 * cwd and dropped when there is none.
 */
export function localFileUrlFrom(path: string, cwd?: string) {
  const target = path.trim()
  if (!target) return undefined
  if (isLocalPath(target)) return localFileUrl(target)
  const root = cwd?.trim()
  if (!root) return undefined
  const separator = root.includes("\\") ? "\\" : "/"
  const base = root.replace(/[\\/]+$/, "")
  return localFileUrl(`${base}${separator}${target.replace(/^[\\/]+/, "")}`)
}

/** Every local file an answer's markdown already points at through the route. */
export function localFilesInMarkdown(markdown: string): string[] {
  if (!markdown.includes(FILE_ROUTE)) return []
  const found: string[] = []
  for (const match of markdown.matchAll(FILE_ROUTE_PATTERN)) {
    try {
      found.push(decodeURIComponent(match[1]))
    } catch {
      /* a target that is not encoded is not one we wrote */
    }
  }
  return found
}
