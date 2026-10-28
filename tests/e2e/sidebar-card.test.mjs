import assert from "node:assert/strict"
import { test } from "node:test"
import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

test("chat cards keep selection, rename and context menu", async () => {
  const app = await startApp()
  let browser
  try {
    const response = await fetch(`${app.baseUrl}/api/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Card example", cwd: app.folder, gitBranch: "feature-card", providerId: "mock" }),
    })
    assert.equal(response.status, 201)
    browser = await launchChromium(await loadPlaywright())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(app.baseUrl, { waitUntil: "domcontentloaded" })
    const card = page.locator('[data-slot="app-sidebar-chat-card"]').filter({ hasText: "Card example" })
    await card.waitFor({ timeout: 30000 })
    assert.equal(await card.getByText("feature-card").count(), 1)
    const row = card.locator('xpath=ancestor::button[@data-slot="sidebar-item-button"]')
    await row.dblclick()
    const rename = page.locator('[data-slot="sidebar-item-input"]')
    await rename.fill("Renamed card")
    await rename.press("Enter")
    const renamed = page.locator('[data-slot="sidebar-item-button"][title="Renamed card"]')
    await renamed.waitFor()
    await renamed.click({ button: "right" })
    assert.ok(await page.getByRole("menuitem", { name: /delete/i }).count())
  } finally {
    await browser?.close()
    await app.stop()
  }
})
