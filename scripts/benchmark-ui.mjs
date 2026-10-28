// Production browser benchmark. See docs/performance.md for setup and caveats.
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { launchChromium, loadPlaywright, startApp } from "../tests/e2e/server.mjs"

const app = await startApp()
let browser
try {
  const count = Number(process.env.AGENT_UI_BENCH_MESSAGES || 200)
  const iterations = Number(process.env.AGENT_UI_BENCH_SAMPLES || 5)
  const response = await fetch(`${app.baseUrl}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Performance fixture", providerId: "mock", model: "mock" }),
  })
  if (!response.ok) throw new Error(`create session: ${response.status}`)
  const { session } = await response.json()
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `bench-${i}`, sender: i % 2 ? "assistant" : "user",
    content: `Benchmark message ${i}. ${"A realistic sentence with some text and code. ".repeat(8)}`,
    createdAt: Date.now() + i,
  }))
  await writeFile(path.join(app.dataDir, "sessions", `${session.id}.json`), JSON.stringify(messages))
  browser = await launchChromium(await loadPlaywright())
  const result = { cold: [], reload: [], typing: [], send: [], domNodes: [] }
  for (let i = 0; i < iterations; i++) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await context.newPage()
    let start = performance.now()
    await page.goto(app.baseUrl, { waitUntil: "domcontentloaded" })
    await page.getByText(`Benchmark message ${count - 1}.`, { exact: false }).waitFor({ timeout: 30000 })
    result.cold.push(performance.now() - start)
    start = performance.now()
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(`Benchmark message ${count - 1}.`, { exact: false }).waitFor({ timeout: 30000 })
    result.reload.push(performance.now() - start)
    result.domNodes.push(await page.locator("*").count())
    const input = page.locator('[data-slot="chat-input-textarea"]')
    await input.click()
    const elapsed = await page.evaluate(async () => {
      const samples = []
      for (let i = 0; i < 30; i++) {
        const t = performance.now()
        document.execCommand("insertText", false, "a")
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        samples.push(performance.now() - t)
      }
      return samples
    })
    result.typing.push(...elapsed)
    await input.fill(`Benchmark send ${i}`)
    start = performance.now()
    await input.press("Enter")
    await page.locator('[data-slot="message"][data-sender="user"]').filter({ hasText: `Benchmark send ${i}` }).waitFor({ timeout: 30000 })
    result.send.push(performance.now() - start)
    await context.close()
  }
  const summarize = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return { median: +sorted[Math.floor(sorted.length / 2)].toFixed(1), p95: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(1), samples: values.length }
  }
  console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([key, values]) => [key, summarize(values)])), null, 2))
} finally {
  await browser?.close()
  await app.stop()
}
