import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { after, before, test } from "node:test"

import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

/**
 * The file panel against the real build: what it renders when the turn that
 * opened it carried only a *look* at the file.
 *
 * This is the regression suite for "the File view shows the first forty lines
 * of a three-thousand-line file". A read tool's output is a window — `limit`
 * and `offset` are the point of it, and every harness caps tool output at 50k
 * characters besides — and the panel used to treat any body at all as reason
 * not to go to disk. Nothing short of the real server, the real route and a
 * real browser proves that end to end, which is why it is here rather than in
 * the pure suite beside `lib/file-preview-source`.
 */

const UI_TIMEOUT = 30_000
const LINES = 900

let app
let browser

before(async () => {
  app = await startApp()
  browser = await launchChromium(await loadPlaywright())
})

after(async () => {
  await browser?.close().catch(() => {})
  await app?.stop()
})

/** A chat pointed at the scratch folder, with `messages` already in it. */
async function seedChat(title, messages) {
  const created = await fetch(`${app.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, providerId: "mock", cwd: app.folder }),
  })
  const { session } = await created.json()
  await fetch(`${app.baseUrl}/api/sessions/${session.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  })
  return session
}

/** One assistant turn whose only tool is a read of `file`. */
function readTurn(file, output, args = {}) {
  return [
    { id: "ask", sender: "user", content: `Look at ${file}` },
    {
      id: "reply",
      sender: "assistant",
      content: "Here it is.",
      tools: [
        {
          id: "read-it",
          name: "Read",
          status: "done",
          input: JSON.stringify({ path: file, ...args }),
          output,
        },
      ],
    },
  ]
}

async function openChat(session) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript(
    (id) => localStorage.setItem("agent-ui:active-session", id),
    session.id
  )
  await page.goto(app.baseUrl, { waitUntil: "domcontentloaded" })
  return page
}

/** Every `GET /api/file` the page makes, in order. */
function watchFileReads(page) {
  const reads = []
  page.on("request", (request) => {
    if (request.url().includes("/api/file?")) reads.push(request.url())
  })
  return reads
}

/**
 * A finished turn settles with its tool rows behind one "Worked for …"
 * disclosure, so the row has to be revealed before it can be clicked.
 */
async function openToolRow(page) {
  const stack = page.locator('[data-slot="message-process-trigger"]').first()
  await stack.waitFor({ timeout: UI_TIMEOUT })
  await stack.click()
  const row = page
    .locator('[data-slot="message-tool-call-trigger"][data-action="open-file"]')
    .first()
  await row.waitFor({ timeout: UI_TIMEOUT })
  await row.click()
}

/**
 * How tall the file body is, in pixels — which is how much file the panel
 * thinks it has.
 *
 * The viewer renders its rows into a custom element's shadow root and mounts
 * only the ones on screen, so neither `textContent` nor a row count says how
 * long the file is. The scroller it sizes does, and the two cases are orders
 * of magnitude apart: forty lines is under a thousand pixels, nine hundred is
 * eighteen thousand.
 */
async function fileBodyHeight(page) {
  await page
    .locator('[data-slot="file-preview-body"]')
    .waitFor({ timeout: UI_TIMEOUT })
  return page.evaluate(async () => {
    const root = document.querySelector('[data-slot="file-preview-body"]')
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const scroller = [...root.querySelectorAll("*")].find(
        (element) => element.scrollHeight > element.clientHeight + 8
      )
      if (scroller) return scroller.scrollHeight
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return 0
  })
}

test("a read tool's window does not become the file the panel shows", async () => {
  const lines = Array.from(
    { length: LINES },
    (_, index) => `const line${index + 1} = ${index + 1}`
  )
  await writeFile(path.join(app.folder, "big.ts"), `${lines.join("\n")}\n`, "utf8")

  // Exactly what a harness publishes for `Read(big.ts, limit: 40)`: the first
  // forty lines as the tool's output, and the arguments that say so.
  const session = await seedChat(
    "Read window",
    readTurn("big.ts", lines.slice(0, 40).join("\n"), { limit: 40 })
  )

  const page = await openChat(session)
  // The regression at the layer it happened: the panel used to skip this
  // request entirely whenever the tool call carried any body at all.
  const reads = watchFileReads(page)
  await openToolRow(page)

  const height = await fileBodyHeight(page)
  assert.ok(
    reads.some((url) => url.includes("big.ts")),
    `the panel went to disk for the file (requests: ${JSON.stringify(reads)})`
  )
  assert.ok(
    height > 10_000,
    `the panel is sized for the whole 900-line file, not the tool's 40-line window (body is ${height}px)`
  )
  await page.close()
})

test("a whole after-file a mutation tool wrote is left alone", async () => {
  // The other half of the rule. An Edit's after-file is the state that turn
  // produced, and the diff beside it describes exactly that — going to disk
  // here would show a later file than the turn under review.
  await writeFile(path.join(app.folder, "edited.ts"), "on disk now\n", "utf8")
  const session = await seedChat("After file", [
    { id: "ask", sender: "user", content: "Edit it" },
    {
      id: "reply",
      sender: "assistant",
      content: "Done.",
      tools: [
        {
          id: "edit-it",
          name: "Write",
          status: "done",
          input: JSON.stringify({
            path: "edited.ts",
            content: "what the turn wrote\n",
          }),
        },
      ],
    },
  ])

  const page = await openChat(session)
  const reads = watchFileReads(page)
  await openToolRow(page)
  await page
    .locator('[data-slot="file-preview-body"]')
    .waitFor({ timeout: UI_TIMEOUT })
  await page.waitForTimeout(1_000)
  assert.deepEqual(reads, [], "no disk read: the turn's own after-file stands")
  await page.close()
})

test("a file bigger than the route's cap says so instead of ending silently", async () => {
  // Over MAX_BYTES (1.5 MB) in app/api/file/route.ts, so the route serves a
  // head. Without the banner that head is indistinguishable from a file that
  // simply ends there.
  const huge = `${"x".repeat(80)}\n`.repeat(30_000)
  await writeFile(path.join(app.folder, "huge.log"), huge, "utf8")
  assert.ok(Buffer.byteLength(huge) > 1_536_000, "the fixture is over the cap")

  const session = await seedChat("Huge file", readTurn("huge.log", "xxxx"))
  const page = await openChat(session)
  await openToolRow(page)

  const banner = page.locator('[data-slot="file-panel-truncated"]')
  await banner.waitFor({ timeout: UI_TIMEOUT })
  const said = await banner.innerText()
  assert.match(said, /Showing the start of this file/)
  assert.match(said, /2\.4 MB/, `the banner names the real size: ${said}`)
  await page.close()
})

test("the route reports the size it truncated at", async () => {
  const session = await seedChat("Route shape", [])
  const response = await fetch(
    `${app.baseUrl}/api/file?path=huge.log&session=${session.id}`
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.truncated, true)
  assert.equal(body.bytes, 2_430_000)
  assert.ok(body.content.length <= 1_536_000)

  // A file under the cap is not flagged, and carries no size.
  const small = await fetch(
    `${app.baseUrl}/api/file?path=big.ts&session=${session.id}`
  )
  const smallBody = await small.json()
  assert.equal(smallBody.truncated, undefined)
  assert.equal(smallBody.bytes, undefined)
})
