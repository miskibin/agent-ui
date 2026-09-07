import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { after, test } from "node:test"

import {
  clearDevServerCache,
  discoverDevServers,
  parseLsofListeners,
  probeListeners,
  COMMON_DEV_PORTS,
} from "@/lib/dev-servers"

/**
 * Which local ports the app is willing to call a dev server.
 *
 * The parser is checked against real `lsof -F` output, and the publishing rule
 * against real servers on real loopback ports — the point of the probe is that
 * a listener which is not serving pages (a database, an API, a socket that
 * accepts and says nothing) never reaches the UI, and only a live socket can
 * demonstrate that.
 */

const servers: Server[] = []

after(() => {
  for (const server of servers) server.close()
})

/** A server on an ephemeral port, torn down with the suite. */
function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(typeof address === "object" && address ? address.port : 0)
    })
  })
}

test("lsof's -F stream carries the process across its socket lines", () => {
  const listeners = parseLsofListeners(
    [
      "p1234",
      "cnode",
      "fu1",
      "n*:5173",
      "n127.0.0.1:24678",
      "p88",
      "cpostgres",
      "n127.0.0.1:5432",
      "p99",
      "cshared",
      // Not loopback: somebody else's server on the LAN.
      "n192.168.1.10:8080",
      "n[::1]:3000",
    ].join("\n")
  )
  assert.deepEqual(listeners, [
    { port: 3000, pid: 99, command: "shared" },
    { port: 5173, pid: 1234, command: "node" },
    { port: 5432, pid: 88, command: "postgres" },
    { port: 24678, pid: 1234, command: "node" },
  ])
})

test("a name field that is not an address is skipped, not guessed at", () => {
  const listeners = parseLsofListeners(
    ["p7", "cweird", "n/tmp/some.sock", "nlocalhost:0", "nlocalhost:99999", "n*:8080"].join(
      "\n"
    )
  )
  assert.deepEqual(listeners, [{ port: 8080, pid: 7, command: "weird" }])
})

test("the curated fallback list is loopback dev ports, in no particular order", () => {
  assert.ok(COMMON_DEV_PORTS.includes(3000))
  assert.ok(COMMON_DEV_PORTS.includes(5173))
  assert.equal(new Set(COMMON_DEV_PORTS).size, COMMON_DEV_PORTS.length)
})

test("only a listener that serves a page is published", async () => {
  clearDevServerCache()
  const html = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end("<html><head><title>  My\n  App </title></head><body>hi</body></html>")
  })
  const api = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end('{"ok":true}')
  })
  const redirect = await listen((_req, res) => {
    res.writeHead(302, { location: "/login" })
    res.end()
  })
  const silent = await listen((_req, res) => {
    res.writeHead(204)
    res.end()
  })

  const found = await probeListeners([
    { port: html, pid: 1, command: "node" },
    { port: api, pid: 2, command: "postgres" },
    { port: redirect, pid: 3 },
    { port: silent },
  ])
  assert.deepEqual(
    found.map((server) => server.port),
    [html, api, redirect, silent].filter((port) => port === html || port === redirect)
  )
  const page = found.find((server) => server.port === html)
  assert.equal(page?.url, `http://localhost:${html}`)
  assert.equal(page?.command, "node")
  // Collapsed whitespace, so a title with a newline in it stays one line.
  assert.equal(page?.title, "My App")
  assert.equal(found.find((server) => server.port === redirect)?.title, undefined)
})

test("a port nothing is listening on is not a dev server", async () => {
  clearDevServerCache()
  const dead = await listen((_req, res) => res.end())
  await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()))
  assert.deepEqual(await probeListeners([{ port: dead }]), [])
})

test("the probe is cached per port and pid", async () => {
  clearDevServerCache()
  let hits = 0
  const port = await listen((_req, res) => {
    hits += 1
    res.writeHead(200, { "content-type": "text/html" })
    res.end("<title>Cached</title>")
  })
  await probeListeners([{ port, pid: 1 }])
  await probeListeners([{ port, pid: 1 }])
  assert.equal(hits, 1)
  // A different process on the same port is a different server.
  await probeListeners([{ port, pid: 2 }])
  assert.equal(hits, 2)
})

test("an excluded port is never published", async () => {
  clearDevServerCache()
  const port = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end("<title>Agent UI</title>")
  })
  const found = await discoverDevServers({ exclude: [port] })
  assert.equal(
    found.some((server) => server.port === port),
    false
  )
})
