import assert from "node:assert/strict"
import { test } from "node:test"

import { crossOriginRefusal } from "@/lib/request-origin"

/**
 * The one thing every API route refuses. There is no login here — the server
 * answers whoever reaches `127.0.0.1` — so the check has exactly one job: a
 * page on another origin, open in the same browser, must not be able to drive
 * this app. Everything a real client sends has to keep working, the desktop
 * shell's header-less health probe included.
 */

const HOST = "127.0.0.1:4319"

function request(
  method: string,
  headers: Record<string, string> = {}
): Request {
  return new Request(`http://${HOST}/api/settings`, {
    method,
    headers: { host: HOST, ...headers },
  })
}

test("the app's own fetches and its images go through", () => {
  assert.equal(crossOriginRefusal(request("GET", { "sec-fetch-site": "same-origin" })), null)
  assert.equal(
    crossOriginRefusal(
      request("PUT", {
        "sec-fetch-site": "same-origin",
        origin: `http://${HOST}`,
      })
    ),
    null
  )
  // Typing the URL, or opening a file in a tab of its own.
  assert.equal(crossOriginRefusal(request("GET", { "sec-fetch-site": "none" })), null)
})

test("a page on another site is refused, reads and writes alike", async () => {
  for (const site of ["cross-site", "same-site"]) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const refusal = crossOriginRefusal(request(method, { "sec-fetch-site": site }))
      assert.equal(refusal?.status, 403, `${method} ${site}`)
      assert.equal((await refusal!.json()).error, "Cross-site request")
    }
  }
})

test("a mutating request whose Origin is not this server is refused", () => {
  for (const origin of ["http://evil.example", "null", "http://127.0.0.1:9999"]) {
    assert.equal(crossOriginRefusal(request("POST", { origin }))?.status, 403, origin)
  }
  // Host and port, not scheme: `Host` carries none, and nothing else can be
  // listening on the port this server holds.
  assert.equal(crossOriginRefusal(request("POST", { origin: `https://${HOST}` })), null)
  // A read is not refused on `Origin` alone: a cross-origin GET cannot read
  // the answer anyway, and `sec-fetch-site` above is what catches it.
  assert.equal(crossOriginRefusal(request("GET", { origin: "http://evil.example" })), null)
})

test("a client that is not a browser keeps working", () => {
  // curl, a script, and the Tauri shell's health probe: no `Origin`, no fetch
  // metadata, nothing to check — and nothing to protect against either.
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(crossOriginRefusal(request(method)), null, method)
  }
})
