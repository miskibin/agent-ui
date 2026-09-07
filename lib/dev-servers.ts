import "server-only"

import { execFile } from "node:child_process"
import { readlink } from "node:fs/promises"
import path from "node:path"

import { realPath } from "@/lib/fs-roots"

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * The dev servers already running on this machine.
 *
 * An agent that has just been told to "start the dev server" leaves a listener
 * behind and says so in prose; the app can do better than prose, and the
 * ingredient it needs is a list of local ports that answer with a *page*.
 *
 * Two ways of getting the candidates, one way of confirming them:
 *
 * - **`lsof -iTCP -sTCP:LISTEN -P -n -F pcn`** on macOS and Linux. The `-F`
 *   form is the only one worth parsing — one field per line, tagged by its
 *   first character — because lsof's human-readable columns are aligned, not
 *   delimited, and a command name with a space in it silently shifts them.
 * - **A curated port list** on Windows, and anywhere lsof is missing. Guessing
 *   is worse than looking, but it costs one bounded request per port.
 * - **A bounded HTTP GET** decides what is published, in both cases. A
 *   listener is a dev server only if it answers with an HTML document or
 *   redirects to one, which is what keeps Postgres, Redis, an SSH tunnel and
 *   the app's own database out of a list the user is meant to click.
 *
 * Results are cached briefly per URL *and pid*: a port that is reused by a
 * different process is a different server, and the point of the cache is to
 * stop a poll from re-probing sixteen ports every few seconds, not to remember
 * anything for long.
 */

export type DevServer = {
  /** Always loopback: `http://localhost:<port>`. */
  url: string
  port: number
  /** The listening process, when the platform told us. */
  pid?: number
  /** The process name lsof reported (`node`, `bun`, `python3`, …). */
  command?: string
  /** The page's `<title>`, when it had a short one. */
  title?: string
}

/** Where dev servers land when nothing told them otherwise. */
export const COMMON_DEV_PORTS = [
  3000, 3001, 4173, 5173, 5174, 8000, 8080, 8081, 4200, 1420, 6006, 3333, 1234,
] as const

/** A probe is a page load on loopback; more than this and it is not one. */
const PROBE_TIMEOUT_MS = 800
const LSOF_TIMEOUT_MS = 3_000
/** Long enough to spare a poll, short enough that a restart shows up. */
const CACHE_TTL_MS = 12_000
/** Sixteen sockets to loopback is nothing; sixteen hundred would not be. */
const PROBE_CONCURRENCY = 8
/** Enough of the document to hold its `<title>`. */
const TITLE_SCAN_BYTES = 16 * 1024
const MAX_TITLE_CHARS = 80

/**
 * The host halves lsof prints for a socket bound locally. A server bound to a
 * LAN address is somebody else's business; `*` and `0.0.0.0` are reachable on
 * loopback, which is where the probe goes.
 */
const LOCAL_HOST_TOKENS = new Set([
  "*",
  "0.0.0.0",
  "127.0.0.1",
  "localhost",
  "[::1]",
  "[::]",
  "::1",
  "::",
])

/** A listener, before anything has confirmed it serves pages. */
export type Listener = { port: number; pid?: number; command?: string }

/* -------------------------------------------------------------------------- */
/* Candidates                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `lsof -F pcn` output → the local TCP listeners in it.
 *
 * Pure, and exported for the tests. The format is a stream of tagged lines
 * that *carry state*: a `p` line opens a process, `c` names it, and every `n`
 * line after that belongs to it until the next `p`.
 */
export function parseLsofListeners(stdout: string): Listener[] {
  const byPort = new Map<number, Listener>()
  let pid: number | undefined
  let command: string | undefined

  for (const line of stdout.split("\n")) {
    if (!line) continue
    const tag = line[0]
    const value = line.slice(1)
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10)
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
      command = undefined
      continue
    }
    if (tag === "c") {
      command = value.trim() || undefined
      continue
    }
    if (tag !== "n") continue
    const port = parseLsofPort(value)
    if (port === null || byPort.has(port)) continue
    byPort.set(port, {
      port,
      ...(pid === undefined ? null : { pid }),
      ...(command === undefined ? null : { command }),
    })
  }
  return [...byPort.values()].sort((left, right) => left.port - right.port)
}

/**
 * The port of an lsof name field, when the address is a local one.
 *
 * Shapes: `*:5173`, `127.0.0.1:5173`, `[::1]:5173`, `localhost:5173 (LISTEN)`,
 * and `192.168.1.10:5173`, which is the one this drops.
 */
function parseLsofPort(name: string): number | null {
  const address = name.trim().split(" ")[0] ?? ""
  const colon = address.lastIndexOf(":")
  if (colon < 0) return null
  if (!LOCAL_HOST_TOKENS.has(address.slice(0, colon))) return null
  const port = Number.parseInt(address.slice(colon + 1), 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null
  return port
}

/** One bounded `lsof`; null when there is none, or it failed. */
function runLsof(): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      /*turbopackIgnore: true*/ "lsof",
      ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"],
      {
        timeout: LSOF_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => {
        // lsof exits non-zero when *some* descriptor was unreadable, which is
        // normal for an unprivileged process — the output it did produce is
        // still the answer.
        resolve(stdout && stdout.trim() ? stdout : error ? null : "")
      }
    )
  })
}

/**
 * The working directory of a process, on a platform that publishes one.
 *
 * Linux only, and best effort by design: `/proc/<pid>/cwd` is a symlink only
 * the owner may read, so "unreadable" has to mean "keep the listener" rather
 * than "drop it" — a filter that silently hid every server of a process it
 * could not introspect would be worse than no filter.
 */
async function processCwd(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null
  try {
    return await readlink(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* The probe                                                                   */
/* -------------------------------------------------------------------------- */

type ProbeResult = { serves: boolean; title?: string }
const probeCache = new Map<string, { at: number; result: ProbeResult }>()

function cacheKey(port: number, pid?: number) {
  return `${port}|${pid ?? ""}`
}

/** Trim the cache whenever it is looked at; nothing here runs on a timer. */
function evictExpired(now: number) {
  for (const [key, entry] of probeCache) {
    if (now - entry.at > CACHE_TTL_MS) probeCache.delete(key)
  }
}

/** The document's title, if the first chunk of it carried a usable one. */
function readTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = match?.[1]
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_CHARS)
  return title || undefined
}

/**
 * Does this port answer like a web server?
 *
 * `redirect: "manual"`, because a redirect *is* the answer for a dev server
 * that bounces `/` to `/login` or `/en`, and following it would turn a probe
 * into a crawl. A 2xx has to name itself HTML: a JSON API on 8080 is a real
 * thing to be running and is not what this chip offers to open.
 */
async function probe(url: string): Promise<ProbeResult> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location")?.trim()
      await res.body?.cancel()
      return { serves: Boolean(location) }
    }
    if (res.status < 200 || res.status >= 300 || res.status === 204) {
      await res.body?.cancel()
      return { serves: false }
    }
    const type = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
    if (type !== "text/html" && type !== "application/xhtml+xml") {
      await res.body?.cancel()
      return { serves: false }
    }
    const head = (await res.text()).slice(0, TITLE_SCAN_BYTES)
    const title = readTitle(head)
    return { serves: true, ...(title ? { title } : null) }
  } catch {
    // Refused, reset, or slower than the budget: not something to offer.
    return { serves: false }
  }
}

/** The probe, through the cache. */
async function probeCached(listener: Listener): Promise<ProbeResult> {
  const now = Date.now()
  evictExpired(now)
  const key = cacheKey(listener.port, listener.pid)
  const hit = probeCache.get(key)
  if (hit) return hit.result
  const result = await probe(`http://127.0.0.1:${listener.port}`)
  probeCache.set(key, { at: now, result })
  return result
}

/** Forgets what was probed — for the tests, and for a manual refresh. */
export function clearDevServerCache() {
  probeCache.clear()
}

/** `tasks` run `limit` at a time, in order, results in order. */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await task(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

export type DiscoverOptions = {
  /**
   * The chat's folder. When given, a listener whose process publishes a
   * working directory outside it is dropped — a process that publishes none is
   * kept, because most do not.
   */
  cwd?: string
  /** Ports never published: the app's own, above all. */
  exclude?: readonly number[]
}

/**
 * Every local port that currently answers with a page.
 *
 * Ordered by port, deduped, and empty rather than throwing: this is a chip in
 * a header, and a failure to look is not something to interrupt anyone with.
 */
export async function discoverDevServers(
  options: DiscoverOptions = {}
): Promise<DevServer[]> {
  const stdout = await runLsof()
  const listeners: Listener[] =
    stdout === null
      ? COMMON_DEV_PORTS.map((port) => ({ port }))
      : parseLsofListeners(stdout)

  const excluded = new Set(options.exclude ?? [])
  const candidates = listeners.filter((entry) => !excluded.has(entry.port))
  const scoped = options.cwd
    ? await withinFolder(candidates, options.cwd)
    : candidates

  return probeListeners(scoped)
}

/**
 * The listeners that answer with a page, as servers. Exported as its own step
 * because it is the half worth testing: which candidates *become* dev servers
 * is the rule, and where the candidates came from is the platform's business.
 */
export async function probeListeners(
  listeners: readonly Listener[]
): Promise<DevServer[]> {
  const probed = await pooled(listeners, PROBE_CONCURRENCY, async (listener) => {
    const result = await probeCached(listener)
    if (!result.serves) return null
    const server: DevServer = {
      url: `http://localhost:${listener.port}`,
      port: listener.port,
      ...(listener.pid === undefined ? null : { pid: listener.pid }),
      ...(listener.command === undefined ? null : { command: listener.command }),
      ...(result.title ? { title: result.title } : null),
    }
    return server
  })
  return probed.filter((entry): entry is DevServer => entry !== null)
}

/** The listeners whose process is working inside `cwd`, plus the unknowable. */
async function withinFolder(
  listeners: readonly Listener[],
  cwd: string
): Promise<Listener[]> {
  const root = await realPath(cwd)
  const kept: Listener[] = []
  for (const listener of listeners) {
    if (listener.pid === undefined) {
      kept.push(listener)
      continue
    }
    const dir = await processCwd(listener.pid)
    if (!dir) {
      kept.push(listener)
      continue
    }
    const real = await realPath(dir)
    if (real === root || real.startsWith(root + path.sep)) kept.push(listener)
  }
  return kept
}
