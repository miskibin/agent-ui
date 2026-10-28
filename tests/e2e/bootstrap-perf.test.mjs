import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

test("a saved chat opens while provider discovery is blocked", async () => {
  const app = await startApp()
  let browser
  let release
  try {
    const response = await fetch(`${app.baseUrl}/api/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Delayed providers", providerId: "mock" }),
    })
    const { session } = await response.json()
    await writeFile(path.join(app.dataDir, "sessions", `${session.id}.json`), JSON.stringify([
      { id: "saved", sender: "user", content: "Restored before providers", createdAt: Date.now() },
    ]))
    browser = await launchChromium(await loadPlaywright())
    const page = await browser.newPage()
    const gate = new Promise((resolve) => { release = resolve })
    let blocked = false
    await page.route("**/api/providers", async (route) => {
      blocked = true
      await gate
      await route.continue().catch(() => {})
    })
    await page.goto(app.baseUrl, { waitUntil: "domcontentloaded" })
    await page.getByText("Restored before providers").waitFor({ timeout: 15000 })
    assert.equal(blocked, true)
    release()
    await page.locator('[data-slot="provider-picker-trigger"]').waitFor({ timeout: 15000 })
    assert.equal(await page.getByText("Restored before providers").count(), 1)
  } finally {
    release?.()
    await browser?.close()
    await app.stop()
  }
})
