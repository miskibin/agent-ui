import assert from "node:assert/strict"
import { test } from "node:test"
import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

const TIMEOUT = 30_000

test("T3 activity: live headers, visible commentary, then one Worked fold", async () => {
  const app = await startApp()
  let browser
  try {
    browser = await launchChromium(await loadPlaywright())
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
    page.setDefaultTimeout(TIMEOUT)
    await page.goto(app.baseUrl)
    await page.locator('[aria-label="Provider: Mock agent"]').waitFor()
    const composer = page.locator('[data-slot="chat-input-textarea"]')
    await composer.fill("Show the activity timeline")
    await composer.press("Enter")

    const groups = page.locator('[data-slot="message-activity-trigger"]')
    await groups.filter({ hasText: "Thinking" }).waitFor()
    assert.equal(await groups.first().getAttribute("aria-expanded"), "false")
    const firstControls = await groups.first().getAttribute("aria-controls")
    await groups.first().filter({ hasText: "Reading file" }).waitFor()
    assert.equal(await groups.first().getAttribute("aria-controls"), firstControls, "same group updates its headline")
    assert.equal(await groups.first().getAttribute("aria-expanded"), "false")
    await groups.first().click()
    await page.locator('[data-slot="message-tool-call"]').waitFor()
    await groups.first().click()

    const firstComment = page.getByText("Reading finished. I will check the project.", { exact: true })
    await firstComment.waitFor()
    assert.ok(await firstComment.isVisible(), "commentary is outside the closed activity group")
    await groups.filter({ hasText: /Running.*npm/ }).waitFor()
    assert.equal(await page.locator('[data-slot="message-process-trigger"]').count(), 0, "no turn-level fold during streaming")
    await groups.filter({ hasText: /Running.*git/ }).waitFor()

    const secondComment = page.getByText("Both checks passed. Waiting for the next check.", { exact: true })
    await secondComment.waitFor()
    await groups.filter({ hasText: "Ran 2 commands" }).waitFor()
    assert.ok(await firstComment.isVisible())
    assert.ok(await secondComment.isVisible())
    const sleeping = page.locator('[data-slot="message-activity-trigger"] [data-slot="message-tool-call-countdown"]')
    await sleeping.filter({ hasText: /sleeping/i }).waitFor()
    assert.equal(await groups.count(), 3)
    assert.equal(await page.locator('[data-slot="message-activity-content"]:visible').count(), 0)
    await page.screenshot({ path: "/tmp/t3-activity-live.png" })
    await groups.last().filter({ hasText: "Thinking" }).waitFor()
    await page.getByText("Finished. All checks passed.", { exact: true }).waitFor()
    await page.locator('[title="Stop generating"]').waitFor({ state: "hidden" })

    const worked = page.locator('[data-slot="message-process-trigger"]')
    await worked.waitFor()
    assert.equal(await worked.count(), 1)
    assert.match(await worked.innerText(), /Worked for/)
    assert.equal(await worked.getAttribute("aria-expanded"), "false")
    assert.equal(await groups.count(), 0)
    assert.equal(await firstComment.isVisible(), false)
    assert.ok(await page.getByText("Finished. All checks passed.", { exact: true }).isVisible())
    await worked.click()
    assert.ok(await firstComment.isVisible())
    assert.ok(await secondComment.isVisible())
    assert.equal(await page.locator('[data-slot="message-tool-call"]').count(), 4)
    await page.reload()
    await worked.waitFor()
    assert.equal(await worked.getAttribute("aria-expanded"), "false")
    assert.ok(await page.getByText("Finished. All checks passed.", { exact: true }).isVisible())
    await page.close()
  } finally { await browser?.close(); await app.stop() }
})
