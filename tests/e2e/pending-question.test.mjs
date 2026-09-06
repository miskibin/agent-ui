import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import path from "node:path"
import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

let app
let browser
before(async () => {
  app = await startApp()
  browser = await launchChromium(await loadPlaywright())
})
after(async () => {
  await browser?.close()
  await app?.stop()
})

test("pending questions remain visible while scrolling, then persist the answer", async () => {
  const response = await fetch(`${app.baseUrl}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Question visibility review", providerId: "mock" }),
  })
  const { session } = await response.json()
  const tool = {
    id: "ask-review", name: "AskQuestion", status: "done", output: "Questions skipped by agent",
    input: JSON.stringify({ questions: [{ id: "layout", prompt: "Which layout should we use?",
      options: [{ id: "compact", label: "Compact" }, { id: "wide", label: "Wide" }] }] }),
  }
  const messages = [
    { id: "request", sender: "user", content: "Review the layout." },
    { id: "reply", sender: "assistant", content: Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: reviewing the workspace layout.`).join("\n\n"), tools: [tool] },
  ]
  await fetch(`${app.baseUrl}/api/sessions/${session.id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }),
  })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript((id) => localStorage.setItem("agent-ui:active-session", id), session.id)
  await page.goto(app.baseUrl)
  const question = page.locator('[data-slot="pending-question"]')
  await question.waitFor({ timeout: 30_000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400) // opening layout transition
  assert.equal(await page.locator('[data-slot="ask-question"]').count(), 1)
  const before = await question.boundingBox()
  await page.locator('[data-slot="message-list"]').evaluate((element) => { element.scrollTop = 0 })
  const afterScroll = await question.boundingBox()
  assert.ok(Math.abs(before.y - afterScroll.y) < 2, `question stays anchored: ${before.y} -> ${afterScroll.y}`)
  assert.ok(afterScroll.y >= 0 && afterScroll.y + afterScroll.height <= 900)
  await page.screenshot({ path: path.resolve(".github/screenshots/chat-question.png") })
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "2"))
  await page.waitForTimeout(400)
  const zoomed = await question.boundingBox()
  assert.ok(zoomed.y >= 0 && zoomed.y + zoomed.height <= 900)
  const scrollHeight = await question.locator(":scope > div").evaluate((element) => element.getBoundingClientRect().height)
  assert.ok(scrollHeight <= 410, "question scrolling area respects viewport height at 200% zoom")
  await page.evaluate(() => document.documentElement.style.removeProperty("--ui-scale"))
  await page.setViewportSize({ width: 390, height: 700 })
  await page.waitForTimeout(400) // responsive pane transition
  const mobile = await question.boundingBox()
  assert.ok(mobile.x >= 0 && mobile.x + mobile.width <= 391)
  assert.ok(mobile.y >= 0 && mobile.y + mobile.height <= 700)
  // Isolate the answer replay from model generation; the transcript PUT is real.
  await page.route("**/api/chat", (route) => route.fulfill({
    status: 200, contentType: "text/event-stream", body: 'data: {"type":"done"}\n\n',
  }))
  await question.getByRole("radio", { name: "Compact", exact: true }).click()
  const persisted = page.waitForResponse((response) =>
    response.url().endsWith(`/api/sessions/${session.id}`) && response.request().method() === "PUT"
  )
  await question.getByRole("button", { name: "Continue", exact: true }).click()
  assert.equal((await persisted).status(), 200)
  await question.waitFor({ state: "detached" })
  const stored = await (await fetch(`${app.baseUrl}/api/sessions/${session.id}`)).json()
  const answer = JSON.parse(stored.messages.find((message) => message.id === "reply").tools[0].output)
  assert.deepEqual(answer.answers.layout.optionIds, ["compact"])
  assert.equal(answer.source, "user")
  await page.close()
})
