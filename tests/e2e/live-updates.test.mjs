import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { startApp, loadPlaywright, launchChromium } from "./server.mjs"
let app, browser
before(async () => { app = await startApp(); browser = await launchChromium(await loadPlaywright()) })
after(async () => { await browser?.close(); await app?.stop() })

test("tasks and repeated file edits update while the stream is still open; attached agents finish silently", async () => {
  const post = async (body) => (await (await fetch(`${app.baseUrl}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()).session
  const session = await post({ title: "Live work", providerId: "mock", cwd: app.folder })
  const child = await post({ title: "Attached run", providerId: "mock" })
  await fetch(`${app.baseUrl}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ checkpoints: { enabled: false }, chat: { notificationSounds: true } }) })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await page.addInitScript((id) => {
    localStorage.setItem("agent-ui:active-session", JSON.stringify(id))
    window.playedSounds = []
    window.Audio = class { constructor(src) { this.src = src } play() { window.playedSounds.push(this.src); return Promise.resolve() } }
    const original = window.fetch
    window.fetch = (input, init) => {
      if (String(input) === "/api/chat") return Promise.resolve(new Response(new ReadableStream({ start(controller) { window.chatStream = controller } }), { headers: { "Content-Type": "text/event-stream" } }))
      return original(input, init)
    }
  }, session.id)
  const run = { runId: "silent", sessionId: child.id, prompt: "Review", harness: "mock", model: "", status: "running", startedAt: Date.now(), userMessageId: "cu", assistantMessageId: "ca" }
  await page.route("**/api/subagents/events", (route) => route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "snapshot", runs: [run] })}\n\n` }))
  await page.route("**/api/subagents/silent/stream", (route) => route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"done"}\n\n' }))
  let revision = "first version"
  let reads = 0
  await page.route("**/api/git/diff?*", (route) => { reads++; return route.fulfill({ json: { files: [{ path: "live.ts", status: "M", binary: false, insertions: 1, deletions: 1, patch: `diff --git a/live.ts b/live.ts\n--- a/live.ts\n+++ b/live.ts\n@@ -1 +1 @@\n-old\n+${revision}\n` }] } }) })
  await page.goto(app.baseUrl)
  await page.getByText("Attached run", { exact: true }).waitFor()
  // Allow the watched run to finish and its runner to release the controller.
  await page.waitForFunction(() => !document.querySelector('[data-slot="chat-sidebar"] [data-status="streaming"]'))
  assert.deepEqual(await page.evaluate(() => window.playedSounds), [])
  const composer = page.locator('[data-slot="chat-input-textarea"]')
  await composer.fill("Implement live updates")
  await composer.press("Enter")
  await page.waitForFunction(() => !!window.chatStream)
  const emit = (event) => page.evaluate((event) => window.chatStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)), event)
  await emit({ type: "tool", id: "todos", name: "TodoWrite", status: "done", input: JSON.stringify({ todos: [{ content: "Fix live updates", status: "in_progress" }] }) })
  await page.getByText("Fix live updates", { exact: true }).first().waitFor()
  await emit({ type: "tool", id: "edit", name: "Edit", status: "done", input: JSON.stringify({ file_path: "live.ts", old_string: "old", new_string: "first version" }) })
  const changed = page.getByRole("button", { name: "1 file changed in this chat", exact: true })
  await changed.waitFor()
  await changed.click()
  const panel = page.locator('[data-slot="changes-panel"]')
  await panel.getByText("first version", { exact: false }).first().waitFor()
  revision = "second version"
  await panel.getByText("second version", { exact: false }).first().waitFor({ timeout: 10000 })
  assert.ok(reads >= 2)
  assert.equal(await page.locator('[data-slot="chat-input-stop"]').count(), 1)
  assert.deepEqual(await page.evaluate(() => window.playedSounds), [])
  await emit({ type: "done" })
  await page.evaluate(() => window.chatStream.close())
  await page.locator('[data-slot="chat-input-stop"]').waitFor({ state: "detached" })
  assert.deepEqual(await page.evaluate(() => window.playedSounds), ["/sounds/agent-completion.wav"])
  await page.close()
})
