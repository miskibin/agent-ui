// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * Is a URL's hostname this machine?
 *
 * The question looks like a four-string comparison until it is asked with a
 * real hostname in hand. `127.0.0.1` is one address out of a whole /8, a
 * literal IPv6 host arrives from `URL.hostname` wrapped in brackets, a
 * fully-qualified name may carry a trailing dot, and `::ffff:127.0.0.1` is the
 * same loopback wearing an IPv6 hat. Everything the app decides from "is this
 * local" — spawning a service for it, trusting it without a key — has to see
 * all of those as the one answer, and anything it cannot parse as none of them.
 *
 * Pure and dependency-free: no DNS, no sockets. A name that is not `localhost`
 * is not resolved, so `mymachine.example.com` pointing at 127.0.0.1 reads as
 * remote — deliberately, because the caller is deciding what to *start*, and
 * guessing wrong there is worse than declining.
 */

/** Lowercased, IPv6 brackets stripped, trailing dots removed. */
export function normalizeHostname(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
}

/** The four octets of a dotted-quad, or null for anything else. */
function parseIpv4(host: string): number[] | null {
  const parts = host.split(".")
  if (parts.length !== 4) return null
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN
  )
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null
}

/**
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same address in the two
 * spellings RFC 4291 allows for an IPv4-mapped IPv6 address.
 */
function parseIpv4MappedIpv6(host: string): number[] | null {
  if (!host.startsWith("::ffff:")) return null
  const suffix = host.slice("::ffff:".length)
  const dotted = parseIpv4(suffix)
  if (dotted) return dotted
  const hextets = suffix.split(":")
  if (hextets.length !== 2 || hextets.some((part) => !/^[\da-f]{1,4}$/.test(part))) {
    return null
  }
  const high = Number.parseInt(hextets[0], 16)
  const low = Number.parseInt(hextets[1], 16)
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff]
}

/** `::1`, the whole of `127.0.0.0/8`, and either of those mapped into IPv6. */
export function isLocalLoopbackHost(host: string): boolean {
  const normalized = normalizeHostname(host)
  if (!normalized) return false
  if (normalized === "localhost" || normalized === "::1") return true
  const address = parseIpv4(normalized) ?? parseIpv4MappedIpv6(normalized)
  return address?.[0] === 127
}

/**
 * URLs to actually open a socket to, when `raw` names this machine as
 * `localhost`.
 *
 * Node 17+ resolves that name to `::1` first. Ollama — and most other
 * loopback servers on Windows — bind `127.0.0.1` only, so a fetch to
 * `http://localhost:11434` hangs until TCP gives up instead of succeeding
 * against the server that is already there. Each miss looks like "Ollama is
 * down", and `ensureOllama` answers by spawning `ollama serve`, which on
 * Windows is a new console window every time.
 *
 * Literal `127.0.0.1` and `[::1]` are left alone. `localhost` becomes those
 * two, IPv4 first, never the ambiguous name.
 */
export function loopbackConnectUrls(raw: string): string[] {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return trimmed ? [trimmed.replace(/\/+$/, "")] : []
  }
  if (normalizeHostname(url.hostname) !== "localhost") {
    return [stripBaseUrl(url)]
  }
  // Do not assign `url.hostname = "::1"`: on some Windows/Node builds the
  // setter silently keeps `localhost`, which is the name we are trying to
  // stop fetching.
  return [replaceLoopbackHost(url, "127.0.0.1"), replaceLoopbackHost(url, "[::1]")]
}

function replaceLoopbackHost(url: URL, host: string) {
  const port = url.port ? `:${url.port}` : ""
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")
  return `${url.protocol}//${host}${port}${path}${url.search}${url.hash}`
}

function stripBaseUrl(url: URL) {
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")
  return `${url.origin}${path}${url.search}${url.hash}`
}
