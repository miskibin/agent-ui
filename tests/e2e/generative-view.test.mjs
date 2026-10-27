import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

/**
 * A ```ui fence in an answer is drawn as a view, and a button inside it speaks
 * as the user. The mock agent's streaming scenario ends on one such view, so
 * this runs offline against the production build like the rest of the suite.
 */

const UI_TIMEOUT = 30_000
const BUTTON_TEXT = "Run a few tools so I can see the rows."

let app
let browser
let page

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

describe("generative views", () => {
  test("an answer's ui fence renders as a view, and its button sends the next turn", async () => {
    await page.goto(app.baseUrl, { waitUntil: "domcontentloaded" })
    const composer = page.locator('[data-slot="chat-input-textarea"]')
    await composer.waitFor({ state: "visible", timeout: UI_TIMEOUT })
    await page
      .locator('[data-slot="provider-picker-trigger"][aria-label="Provider: Mock agent"]')
      .waitFor({ timeout: UI_TIMEOUT })

    await composer.fill("stream a markdown answer")
    await composer.press("Enter")

    const card = page.locator('[data-slot="generative-view-card"]', {
      hasText: "Stream pipeline",
    })
    await card.waitFor({ timeout: UI_TIMEOUT })
    // Not JSON on the page: the fence became blocks.
    assert.equal(await page.getByText('"type":"card"').count(), 0)

    const button = card.getByRole("button", { name: "Show the tool calls" })
    // Held while the fence streams; clickable once the view is whole.
    await page.waitForFunction(
      () =>
        !document.querySelector(
          '[data-slot="generative-view"][data-state="streaming"]'
        ),
      null,
      { timeout: UI_TIMEOUT }
    )
    await page.locator('[title="Stop generating"]').waitFor({
      state: "hidden",
      timeout: UI_TIMEOUT,
    })
    assert.equal(await button.isEnabled(), true)
    await button.click()

    await page
      .locator('[data-slot="message"][data-sender="user"]', { hasText: BUTTON_TEXT })
      .waitFor({ timeout: UI_TIMEOUT })
    // Sent once: the button stays pressed.
    assert.equal(await button.isEnabled(), false)

    const { sessions } = await (await fetch(`${app.baseUrl}/api/sessions`)).json()
    let users = []
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { messages } = await (
        await fetch(`${app.baseUrl}/api/sessions/${sessions[0].id}`)
      ).json()
      users = messages.filter((message) => message.sender === "user")
      if (users.length >= 2) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(users.at(-1).content, BUTTON_TEXT)
  })
})
