import assert from "node:assert/strict"
import path from "node:path"
import { after, before, test } from "node:test"
import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

let app, browser
const UI_TIMEOUT = 30_000
const tool = (id, name = "Read") => ({ id, name, status: "done", input: '{"path":"src/example.ts"}', output: "example result" })
const chartData = [{ label: "Mon", a: 12, b: 8 }, { label: "Tue", a: 24, b: null }, { label: "Wed", a: -4, b: 16 }]
const chart = (kind) => ({ type: "chart", kind, title: `${kind} activity`, series: [{ key: "a", label: "Requests" }, { key: "b", label: "Completed" }], data: chartData })
const answer = ["Results are ready.", "```ui", JSON.stringify({ type: "tabs", items: ["area", "line", "bar", "donut"].map((kind) => ({ label: kind, children: [chart(kind)] })) }), "```"].join("\n")

before(async () => {
  app = await startApp()
  browser = await launchChromium(await loadPlaywright())
})
after(async () => { await browser?.close(); await app?.stop() })

async function openChat(page, messages) {
  const response = await fetch(`${app.baseUrl}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Activity and charts", providerId: "mock" }) })
  const { session } = await response.json()
  await fetch(`${app.baseUrl}/api/sessions/${session.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }) })
  await page.addInitScript((id) => localStorage.setItem("agent-ui:active-session", id), session.id)
  await page.goto(app.baseUrl)
  await page.locator('[data-slot="chat-input-textarea"]').waitFor({ timeout: UI_TIMEOUT })
}

function message() {
  return { id: "a1", sender: "assistant", content: answer, parts: [
    { type: "thinking", id: "think1", text: "First reasoning trace" },
    { type: "tool", id: "tool1", tool: tool("tool1") },
    { type: "thinking", id: "think2", text: "Second reasoning trace" },
    { type: "tool", id: "tool2", tool: tool("tool2", "grep") },
    { type: "text", id: "final", text: answer },
  ] }
}

test("thinking and tools have one shared collapse; the answer stays visible", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  try {
    await openChat(page, [{ id: "u1", sender: "user", content: "Show activity as a chart." }, message()])
    const disclosure = page.locator('[data-slot="message-process-trigger"]')
    await disclosure.waitFor({ timeout: UI_TIMEOUT })
    assert.equal(await disclosure.count(), 1)
    assert.equal(await disclosure.getAttribute("aria-expanded"), "false")
    assert.ok(await page.getByText("Results are ready.", { exact: true }).isVisible())
    await disclosure.click()
    assert.equal(await page.locator('[data-slot="message-reasoning"]').count(), 2)
    assert.equal(await page.locator('[data-slot="message-tool-call"]').count(), 2)
    assert.equal(await page.locator('[data-slot="message-reasoning-trigger"], [data-slot="message-tool-calls-trigger"]').count(), 0)
    const text = await page.locator('[data-slot="message-process-content"]').innerText()
    assert.ok(text.indexOf("First reasoning trace") < text.indexOf("Second reasoning trace"))
    await disclosure.click()
    assert.ok(await page.getByText("Results are ready.", { exact: true }).isVisible())
    const chart = page.locator('[data-slot="generative-view-chart"]')
    await chart.waitFor({ timeout: UI_TIMEOUT })
    assert.equal(await chart.getAttribute("data-kind"), "area")
    if (process.env.AGENT_UI_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.AGENT_UI_SCREENSHOT_DIR, "generative-charts.png") })
  } finally { await page.close() }
})

test("all charts render with tokens, tooltip, exact data and no overflow in both modes", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    await openChat(page, [{ id: "a1", sender: "assistant", content: answer }])
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => document.documentElement.classList.toggle("dark", mode === "dark"), mode)
      for (const kind of ["area", "line", "bar", "donut"]) {
        await page.getByRole("tab", { name: kind, exact: true }).click()
        const chart = page.locator(`[data-slot="generative-view-chart"][data-kind="${kind}"]`)
        await chart.waitFor({ timeout: UI_TIMEOUT })
        assert.ok(await chart.locator('[data-slot="generative-view-chart-mark"]').count())
        assert.ok((await chart.locator('[data-slot="generative-view-chart-mark"]').first().getAttribute(kind === "donut" || kind !== "bar" ? "stroke" : "fill")).includes("--chart-"))
        assert.equal(await chart.locator('[d*="NaN"], [d*="Infinity"]').count(), 0)
        await chart.getByText("View data", { exact: true }).click()
        assert.equal(await chart.locator("tbody tr").count(), 3)
        assert.ok(await chart.getByRole("cell", { name: "12", exact: true }).isVisible())
        const size = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }))
        assert.ok(size.content <= size.width, JSON.stringify(size))
      }
    }
    await page.setViewportSize({ width: 1440, height: 1050 })
    await page.getByRole("tab", { name: "area", exact: true }).click()
    const plot = page.locator('[data-slot="generative-view-chart-plot"]')
    const box = await plot.boundingBox()
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5)
    await page.locator('[data-slot="generative-view-chart-tooltip"]').waitFor()
  } finally { await page.close() }
})

test("live activity can be collapsed and expanded through the same header", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  try {
    await page.goto(app.baseUrl)
    const composer = page.locator('[data-slot="chat-input-textarea"]')
    await page.locator('[aria-label="Provider: Mock agent"]').waitFor({ timeout: UI_TIMEOUT })
    await composer.fill("stream a markdown answer")
    await composer.press("Enter")
    const trigger = page.locator('[data-slot="message-process"][data-streaming="true"] [data-slot="message-process-trigger"]').last()
    await trigger.waitFor({ timeout: UI_TIMEOUT })
    assert.equal(await trigger.getAttribute("aria-expanded"), "true")
    await trigger.click()
    assert.equal(await trigger.getAttribute("aria-expanded"), "false")
    await trigger.click()
    assert.equal(await trigger.getAttribute("aria-expanded"), "true")
    await page.locator('[title="Stop generating"]').click()
  } finally { await page.close() }
})

test("desktop chrome has a 48px drag region without covering window controls", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  try {
    await page.addInitScript(() => {
      window.__TAURI__ = { window: { getCurrentWindow: () => ({ isMaximized: async () => false, onResized: async () => () => {}, minimize: async () => { window.__minimized = true } }) } }
    })
    await page.goto(app.baseUrl)
    const header = page.locator('[data-slot="app-header"]')
    await page.locator('[data-slot="app-header-drag-handle"]').waitFor({ timeout: UI_TIMEOUT })
    assert.equal((await header.boundingBox()).height, 48)
    await page.getByRole("button", { name: "Minimize", exact: true }).click()
    assert.ok(await page.evaluate(() => window.__minimized))
  } finally { await page.close() }
})
