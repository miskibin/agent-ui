import assert from "node:assert/strict"
import { rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"

import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

/**
 * One flow through the real thing: the production build, its own data
 * directory, a browser. The mock provider is the default and needs nothing
 * installed, which is what makes this deterministic and offline.
 *
 * Run it with `npm run test:e2e`; it is deliberately not part of `npm test`,
 * which stays a fast pure-logic suite with no build step.
 */

const UI_TIMEOUT = 30_000

let app
let browser
let page

async function sessions() {
  const response = await fetch(`${app.baseUrl}/api/sessions`)
  const body = await response.json()
  return body.sessions
}

before(async () => {
  app = await startApp()
  const playwright = await loadPlaywright()
  browser = await launchChromium(playwright)
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
})

after(async () => {
  await page?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.stop()
})

describe("a chat with the mock agent", () => {
  test("a prompt streams an answer and a tool call into a new chat", async () => {
    await page.goto(app.baseUrl, { waitUntil: "domcontentloaded" })
    const composer = page.locator('[data-slot="chat-input-textarea"]')
    await composer.waitFor({ state: "visible", timeout: UI_TIMEOUT })
    // The composer accepts typing before the provider list has arrived, and a
    // turn sent in that window has no backend to name — wait for the picker to
    // say which agent is going to answer.
    await page
      .locator('[data-slot="provider-picker-trigger"][aria-label="Provider: Mock agent"]')
      .waitFor({ timeout: UI_TIMEOUT })

    await composer.fill("stream a markdown answer with a tool call")
    await composer.press("Enter")

    // The prompt is echoed as a message of its own…
    await page
      .locator('[data-slot="message"]', { hasText: "stream a markdown answer" })
      .first()
      .waitFor({ timeout: UI_TIMEOUT })
    // …the answer streams in…
    await page
      .getByText("Let me look at how a message is assembled", { exact: false })
      .first()
      .waitFor({ timeout: UI_TIMEOUT })
    // …and the tools it ran are rendered as rows, not as text.
    await page
      .locator('[data-slot="message-tool-call"]')
      .first()
      .waitFor({ timeout: UI_TIMEOUT })

    const [session] = await sessions()
    assert.equal(session.providerId, "mock")
    // The first prompt names the chat.
    assert.match(session.title, /stream a markdown answer/)
  })

  test("stopping the turn keeps what was streamed, and a reload shows it", async () => {
    await page.locator('[title="Stop generating"]').click()

    // The turn is persisted as it settles, so the transcript is what the
    // reload will render — wait for the write rather than for a repaint.
    const [{ id }] = await sessions()
    let stored = []
    for (let attempt = 0; attempt < 100 && stored.length < 2; attempt += 1) {
      const response = await fetch(`${app.baseUrl}/api/sessions/${id}`)
      stored = (await response.json()).messages
      if (stored.length >= 2 && stored[1].content.trim()) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(stored[0].sender, "user")
    assert.equal(stored[1].sender, "assistant")
    assert.ok(stored[1].content.includes("Let me look at how a message is assembled"))
    assert.ok(stored[1].tools.length > 0, "the tool calls are stored with the turn")

    await page.reload({ waitUntil: "domcontentloaded" })
    await page
      .locator('[data-slot="message"]', { hasText: "stream a markdown answer" })
      .first()
      .waitFor({ timeout: UI_TIMEOUT })

    // A settled turn is folded into its own summary, so the reloaded thread
    // shows what the run *did* rather than replaying it — the text and the
    // tool rows are one click away, inside that block.
    const process = page.locator('[data-slot="message-process-trigger"]').first()
    await process.waitFor({ timeout: UI_TIMEOUT })
    await process.click()
    await page
      .getByText("Let me look at how a message is assembled", { exact: false })
      .first()
      .waitFor({ timeout: UI_TIMEOUT })
    await page
      .locator('[data-slot="message-tool-call"]')
      .first()
      .waitFor({ timeout: UI_TIMEOUT })
  })

  test("a turn keeps streaming while another chat is open", async () => {
    const composer = page.locator('[data-slot="chat-input-textarea"]')
    await composer.fill("stream another markdown answer in the background")
    await composer.press("Enter")

    await page
      .getByText("Let me look at how a message is assembled", { exact: false })
      .first()
      .waitFor({ timeout: UI_TIMEOUT })

    const [source] = await sessions()
    await page.getByText("New chat", { exact: true }).click()

    await page
      .getByText("How can I help?", { exact: true })
      .waitFor({ timeout: UI_TIMEOUT })

    // Wait on persistence rather than on the hidden React tree. This proves
    // the server, stream reducer and store all reached the end while another
    // chat occupied the conversation pane.
    let stored = []
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const response = await fetch(`${app.baseUrl}/api/sessions/${source.id}`)
      stored = (await response.json()).messages
      if (
        stored.at(-1)?.sender === "assistant" &&
        stored.at(-1)?.content.includes(
          "Appending to the tail part keeps each chunk"
        )
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    assert.equal(stored.length, 4)
    assert.ok(
      stored.at(-1).content.includes(
        "Appending to the tail part keeps each chunk"
      ),
      "the hidden chat persisted the completed answer"
    )

    await page
      .locator('[data-slot="sidebar-item"]', { hasText: source.title })
      .locator('[data-slot="sidebar-item-button"]')
      .click()
    await page
      .getByText("Appending to the tail part keeps each chunk", { exact: false })
      .waitFor({ timeout: UI_TIMEOUT })
  })

  test("/rename retitles the chat and the sidebar row follows", async () => {
    const composer = page.locator('[data-slot="chat-input-textarea"]')
    await composer.fill("/rename Renamed by the flow suite")
    await composer.press("Enter")

    await page
      .locator('[data-slot="sidebar-item"]', { hasText: "Renamed by the flow suite" })
      .first()
      .waitFor({ timeout: UI_TIMEOUT })

    // The composer ran the command instead of sending it to the agent.
    assert.equal(await composer.inputValue(), "")
    const session = (await sessions()).find(
      (item) => item.title === "Renamed by the flow suite"
    )
    assert.ok(session)
    assert.equal(session.title, "Renamed by the flow suite")
    assert.equal(session.messageCount, 4)
  })
})

/**
 * The file routes over HTTP, against the built app. These are the checks the
 * unit suite cannot make: the containment rule as the route actually applies
 * it, including the roots it resolves server-side from the stored chat.
 */
describe("the file routes as the server applies them", () => {
  let chat
  let readable

  before(async () => {
    // A chat pointed at a scratch folder that *contains* the data directory,
    // so the data-directory refusal is reachable rather than hidden behind the
    // workspace check.
    readable = path.join(app.folder, "notes.txt")
    await writeFile(readable, "hello from the flow suite\n", "utf8")
    const response = await fetch(`${app.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "routes", providerId: "mock", cwd: app.workDir }),
    })
    chat = (await response.json()).session
  })

  const file = (query) => fetch(`${app.baseUrl}/api/file?${query}`)

  test("a file inside the chat's folder is readable by its relative path", async () => {
    const response = await file(`path=project/notes.txt&session=${chat.id}`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).content, "hello from the flow suite\n")
  })

  test("traversal out of the chat's folder is refused", async () => {
    for (const query of [
      `path=../../../../etc/passwd&session=${chat.id}`,
      `path=project/../../../etc/passwd&session=${chat.id}`,
      `path=/etc/passwd&session=${chat.id}`,
    ]) {
      const response = await file(query)
      assert.equal(response.status, 403, query)
      assert.match((await response.json()).error, /outside the workspace/)
    }
  })

  test("the app's own data directory is refused even from inside the folder", async () => {
    const response = await file(`path=data/settings.json&session=${chat.id}`)
    assert.equal(response.status, 403)
    assert.match((await response.json()).error, /not readable/)
  })

  test("a missing path, or a directory, is a 4xx and never a body", async () => {
    assert.equal((await file(`session=${chat.id}`)).status, 400)
    assert.equal((await file(`path=project/nope.txt&session=${chat.id}`)).status, 404)
    assert.equal((await file(`path=project&session=${chat.id}`)).status, 404)
  })

  test("/api/files refuses a cross-site request outright", async () => {
    const response = await fetch(
      `${app.baseUrl}/api/files?path=${encodeURIComponent(readable)}`,
      { headers: { "sec-fetch-site": "cross-site" } }
    )
    assert.equal(response.status, 403)
  })

  test("/api/files serves an absolute path, and only relative to the switch", async () => {
    const outside = path.join(tmpdir(), `agent-ui-e2e-outside-${process.pid}.txt`)
    await writeFile(outside, "outside the app's known roots\n", "utf8")
    const outsideUrl = `${app.baseUrl}/api/files?path=${encodeURIComponent(outside)}`
    const inside = `${app.baseUrl}/api/files?path=${encodeURIComponent(readable)}`

    try {
      // anyPath is on by default: the point of the route is showing a file the
      // agent wrote, wherever it wrote it.
      assert.equal((await fetch(inside)).status, 200)
      assert.equal((await fetch(outsideUrl)).status, 200)

      const settings = await (await fetch(`${app.baseUrl}/api/settings`)).json()
      await fetch(`${app.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...settings, files: { anyPath: false } }),
      })
      try {
        // Off, it is narrowed to the folders the app already works in — the
        // chat's own folder stays readable, everything else does not.
        assert.equal((await fetch(inside)).status, 200)
        const refused = await fetch(outsideUrl)
        assert.equal(refused.status, 403)
        assert.match((await refused.json()).error, /Local files/)
      } finally {
        await fetch(`${app.baseUrl}/api/settings`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settings),
        })
      }
    } finally {
      await rm(outside, { force: true })
    }
  })

  test("/api/files refuses a relative path rather than guessing a root", async () => {
    const response = await fetch(`${app.baseUrl}/api/files?path=notes.txt`)
    assert.equal(response.status, 400)
  })

  const open = (body, headers = {}) =>
    fetch(`${app.baseUrl}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })

  test("nothing is launched for a cross-site request, the data folder, or a rootless path", async () => {
    assert.equal(
      (await open({ path: readable, sessionId: chat.id }, { "sec-fetch-site": "cross-site" }))
        .status,
      403
    )

    const dataFolder = await open({ path: "data", sessionId: chat.id })
    assert.equal(dataFolder.status, 403)
    assert.match((await dataFolder.json()).error, /data folder/)

    // A relative path with no chat behind it has no root to resolve against.
    const rootless = await open({ path: "notes.txt" })
    assert.equal(rootless.status, 400)

    // And a path that does not exist stops before any program is spawned.
    assert.equal((await open({ path: "/nope/nowhere.txt" })).status, 404)
  })
})
