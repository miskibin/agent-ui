import assert from "node:assert/strict"
import { after, before, test } from "node:test"

import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

const UI_TIMEOUT = 30_000

let app
let browser
let page

before(async () => {
  app = await startApp()
  browser = await launchChromium(await loadPlaywright())
  page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  })
  await page.goto(app.baseUrl, { waitUntil: "domcontentloaded" })
  await page
    .locator('[data-slot="chat-input-textarea"]')
    .waitFor({ state: "visible", timeout: UI_TIMEOUT })
  await page.locator('[data-slot="provider-picker-trigger"][aria-label="Provider: Mock agent"]').waitFor({ timeout: UI_TIMEOUT })
})

after(async () => {
  await page?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.stop()
})

test("the chat uses the phone viewport without horizontal overflow", async () => {
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))
  assert.equal(viewport.width, 390)
  assert.ok(viewport.bodyWidth <= viewport.width, JSON.stringify(viewport))
  assert.ok(viewport.documentWidth <= viewport.width, JSON.stringify(viewport))

  const composer = await page.locator('[data-slot="chat-input-textarea"]').boundingBox()
  assert.ok(composer)
  assert.ok(composer.x >= 0)
  assert.ok(composer.x + composer.width <= viewport.width)
})

test("mobile header controls have touch-sized targets", async () => {
  const controls = page.locator(
    '[data-slot="app-header"] button:visible, [data-slot="app-header"] a:visible'
  )
  const boxes = await controls.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return { label: element.getAttribute("aria-label"), width: box.width, height: box.height }
    })
  )
  assert.ok(boxes.length >= 2)
  for (const box of boxes) {
    assert.ok(box.width >= 36, `${box.label} is only ${box.width}px wide`)
    assert.ok(box.height >= 36, `${box.label} is only ${box.height}px tall`)
  }
})

test("the chat drawer traps focus and returns it on Escape", async () => {
  const trigger = page.getByRole("button", { name: "Open chats" })
  await trigger.click()

  const drawer = page.locator('[role="dialog"][aria-label="Chats"][aria-modal="true"]')
  await drawer.waitFor({ state: "visible", timeout: UI_TIMEOUT })
  assert.equal(await drawer.getAttribute("aria-modal"), "true")

  await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-label="Chats"]')?.getBoundingClientRect().x >= 0)
  const box = await drawer.boundingBox()
  assert.ok(box)
  assert.ok(box.x >= 0)
  assert.ok(box.x + box.width <= 390)

  await page.keyboard.press("Shift+Tab")
  assert.equal(
    await page.evaluate(() =>
      Boolean(document.activeElement?.closest('[role="dialog"][aria-label="Chats"]'))
    ),
    true
  )
  await page.keyboard.press("Escape")
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Open chats"
  )
})

test("the composer remains usable when the visual viewport shrinks", async () => {
  await page.setViewportSize({ width: 360, height: 420 })
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  assert.deepEqual(viewport, { width: 360, height: 420 })

  for (const slot of ["chat-input-textarea", "chat-input-send"]) {
    const element = page.locator(`[data-slot="${slot}"]`)
    await element.waitFor({ state: "visible", timeout: UI_TIMEOUT })
    const elementBox = await element.boundingBox()
    assert.ok(elementBox, `${slot} has a box`)
    assert.ok(
      elementBox.x >= 0 && elementBox.x + elementBox.width <= viewport.width,
      `${slot} fits horizontally`
    )
    assert.ok(
      elementBox.y >= 0 && elementBox.y + elementBox.height <= viewport.height,
      `${slot} fits vertically`
    )
  }
})


test("a streamed answer and tool rows fit a narrow phone", async () => {
  await page.setViewportSize({ width: 360, height: 800 })
  await page.locator('[data-slot="provider-picker-trigger"][aria-label="Provider: Mock agent"]').waitFor({ timeout: UI_TIMEOUT })
  const composer = page.locator('[data-slot="chat-input-textarea"]')
  await composer.fill("stream a markdown answer with a tool call")
  await page.locator('[data-slot="chat-input-send"]').click()
  await page.locator('[data-slot="message-tool-call"]').first().waitFor({ timeout: UI_TIMEOUT })
  const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  assert.ok(layout.scrollWidth <= layout.width, JSON.stringify(layout))
  const stop = page.locator('[title="Stop generating"]')
  const box = await stop.boundingBox()
  assert.ok(box && box.width >= 36 && box.height >= 36)
  assert.ok(box.y >= 0 && box.y + box.height <= 800)
  if (process.env.AGENT_UI_MOBILE_SCREENSHOT) {
    await page.screenshot({ path: process.env.AGENT_UI_MOBILE_SCREENSHOT })
  }
  await stop.click()
})
