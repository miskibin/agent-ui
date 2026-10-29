import assert from "node:assert/strict"
import { readFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { after, before, test } from "node:test"
import { startApp, loadPlaywright, launchChromium, ROOT } from "./server.mjs"

let app, browser
before(async () => {
  app = await startApp()
  browser = await launchChromium(await loadPlaywright())
})
after(async () => { await browser?.close(); await app?.stop() })

test("agents panel retains native activity and opens a real MCP-delegated chat", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
  const post = (url, body) => fetch(`${app.baseUrl}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const { session } = await (await post("/api/sessions", { title: "Implement session recovery", providerId: "mock", cwd: app.folder, gitBranch: "main" })).json()
  const tools = [
    { id: "native-task", name: "Agent", status: "done", input: JSON.stringify({ description: "Review persistence", prompt: "Inspect session recovery and report risks." }), output: "Recovery review complete" },
    { id: "native:native-task", name: "agent_ui_native_subagent", status: "done", output: JSON.stringify({ parentToolId: "native-task", model: "claude-sonnet-4-6", text: "Session transcripts are durable. In-flight runs need explicit recovery after a restart.", tools: [{ id: "read", name: "Read", status: "done", input: "lib/subagents/runs.ts", output: "Inspected run registry" }] }) },
  ]
  await fetch(`${app.baseUrl}/api/sessions/${session.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [
    { id: "u", sender: "user", content: "Implement session recovery and get an independent review." },
    { id: "a", sender: "assistant", content: "The review is complete. I am checking the implementation next.", tools, parts: [{ type: "text", text: "The review is complete. I am checking the implementation next." }, ...tools.map((tool) => ({ type: "tool", id: tool.id, tool }))] },
  ] }) })
  await page.addInitScript((id) => localStorage.setItem("agent-ui:active-session", JSON.stringify(id)), session.id)
  await page.goto(app.baseUrl)
  await page.locator('[data-slot="workspace-panel"]').waitFor()
  const scrollRight = await page.locator('[data-slot="message-list"]').evaluate((node) => node.getBoundingClientRect().right)
  assert.ok(Math.abs(scrollRight - 1400) <= 2, "Conversation scrollbar stays at the window's right edge with the dock open")
  const contentBounds = await page.locator('[data-slot="message-list"] > div').first().boundingBox()
  const scrollBounds = await page.locator('[data-slot="message-list"]').boundingBox()
  assert.ok(Math.abs(contentBounds.x + contentBounds.width / 2 - scrollBounds.x - scrollBounds.width / 2) <= 2, "Transcript remains centered with the floating workspace dock open")
  const card = page.locator('[data-slot="subagent-card"]').filter({ hasText: "Review persistence" })
  assert.equal(await card.count(), 0, "Completed agents are not appended to the answer")
  const initialPanel = page.locator('[data-slot="agents-panel"]')
  await initialPanel.locator(":scope > summary").click()
  await initialPanel.getByText("Review persistence", { exact: true }).click()
  const navigation = page.getByRole("navigation", { name: "Agent navigation" })
  await navigation.locator('[aria-current="page"]').filter({ hasText: "Review persistence" }).waitFor()
  await page.locator('[data-slot="message-list"]').getByText("Session transcripts are durable.", { exact: false }).waitFor()
  await page.screenshot({ path: path.join(ROOT, ".github", "screenshots", "subagent-activity.png") })
  await page.setViewportSize({ width: 390, height: 844 })
  const bounds = await navigation.boundingBox()
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390)
  const workspace = page.locator('[data-slot="workspace-panel"]')
  await workspace.waitFor({ state: "detached" })
  await page.getByRole("button", { name: "Toggle workspace panel" }).click()
  const collapsedScrollRight = await page.locator('[data-slot="message-list"]').evaluate((node) => node.getBoundingClientRect().right)
  assert.ok(Math.abs(collapsedScrollRight - 390) <= 2, "The mobile dock preserves the scroll surface's outer edge")
  const mobileWorkspace = await workspace.boundingBox()
  assert.ok(mobileWorkspace && mobileWorkspace.x >= 0 && mobileWorkspace.x + mobileWorkspace.width <= 390)
  await page.getByRole("button", { name: "Toggle workspace panel" }).click()
  await page.setViewportSize({ width: 1400, height: 950 })
  await page.getByRole("button", { name: "Toggle workspace panel" }).click()
  await navigation.getByRole("button", { name: "Implement session recovery", exact: true }).click()
  await page.screenshot({ path: path.join(ROOT, ".github", "screenshots", "subagent-card.png") })
  const panel = page.locator('[data-slot="agents-panel"]')
  if (await panel.getAttribute("open") === null) await panel.locator(":scope > summary").click()
  await panel.getByText("Review persistence", { exact: true }).click()
  await page.locator('[data-slot="message-list"]').getByText("Session transcripts are durable.", { exact: false }).waitFor()
  await page.getByRole("button", { name: "Return to main agent", exact: true }).click()
  assert.equal(await page.locator('[data-slot="message-list"]').getByText('"parentToolId"', { exact: false }).count(), 0)
  const { token } = JSON.parse(await readFile(path.join(app.dataDir, "bridge.json"), "utf8"))
  const rpc = async (name, args) => {
    // The mock harness has no permission modes; this fixture tests navigation,
    // not a sandbox contract it cannot enforce.
    const response = await fetch(`${app.baseUrl}/api/mcp?parent=${session.id}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })
    return response.json()
  }
  const started = await rpc("run_subagent", { harness: "mock", title: "Check implementation", prompt: "Inspect the implementation", background: true })
  assert.equal(started.result.isError, undefined)
  const stored = await (await fetch(`${app.baseUrl}/api/sessions/${session.id}`)).json()
  const delegation = { id: "delegation", name: "mcp__agent-ui__run_subagent", status: "done", input: JSON.stringify({ title: "Check implementation", harness: "mock", prompt: "Inspect the implementation" }), output: JSON.stringify(started.result) }
  stored.messages[1].tools.push(delegation)
  stored.messages[1].parts.push({ type: "tool", id: delegation.id, tool: delegation })
  await fetch(`${app.baseUrl}/api/sessions/${session.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: stored.messages }) })
  await panel.getByText("Check implementation", { exact: true }).waitFor()
  await panel.getByText("1 running task", { exact: true }).waitFor()
  await page.reload()
  await page.locator('[data-slot="subagent-card"]').filter({ hasText: "Check implementation" }).click()
  await page.locator('[data-slot="message-list"]').getByText("Inspect the implementation", { exact: true }).waitFor()
  await navigation.getByRole("button", { name: "Implement session recovery", exact: true }).click()
  if (await panel.getAttribute("open") === null) await panel.locator(":scope > summary").click()
  await mkdir(path.join(ROOT, ".github", "screenshots"), { recursive: true })
  await page.screenshot({ path: path.join(ROOT, ".github", "screenshots", "agents-panel.png") })
  const stop = panel.getByRole("button", { name: "Stop Check implementation", exact: true })
  await stop.click()
  await panel.getByText("mock", { exact: false }).filter({ hasText: "cancelled" }).waitFor()
  await panel.getByRole("button", { name: "Open Check implementation", exact: true }).click()
  await page.getByText("Inspect the implementation", { exact: true }).waitFor()
  await navigation.getByRole("button", { name: "Switch agent" }).click()
  await page.getByRole("menuitem", { name: "Main agent · Implement session recovery" }).click()
  assert.equal(await card.count(), 0)
  assert.equal(await page.locator('[data-slot="chat-composer"] [data-slot="agents-panel"]').count(), 0)
  await page.getByRole("button", { name: "Review workspace changes" }).click()
  await page.locator('[data-slot="changes-panel"]').waitFor()
  await page.locator('[data-slot="workspace-panel"]').waitFor({ state: "detached" })
  const diffPadding = await page.locator('[data-slot="message-list"]').evaluate((node) => parseFloat(getComputedStyle(node).paddingRight))
  assert.ok(diffPadding < 100, "Diff view releases the workspace content inset")
  await page.getByRole("button", { name: "Close the changes", exact: true }).click()
  await page.locator('[data-slot="workspace-panel"]').waitFor()
  await page.close()
})


test("sidebar uses a flat list across projects with only Settled below it", async () => {
  const post = async (body) => (await (await fetch(`${app.baseUrl}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })).json()).session
  await post({ title: "Older project chat", providerId: "mock", cwd: path.join(ROOT, "lib") })
  await post({ title: "Newer project chat", providerId: "mock", cwd: ROOT })
  await post({ title: "Snoozed project chat", providerId: "mock", snoozedUntil: Date.now() + 3600000 })
  await post({ title: "Finished project chat", providerId: "mock", settledOverride: "settled" })
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
  await page.goto(app.baseUrl)
  const sidebar = page.locator('[data-slot="chat-sidebar"]')
  await sidebar.getByText("Newer project chat", { exact: true }).waitFor()
  await sidebar.getByText("Older project chat", { exact: true }).waitFor()
  await sidebar.getByText("Snoozed project chat", { exact: true }).waitFor()
  const headings = await sidebar.locator('[data-slot="sidebar-section-trigger"]').allTextContents()
  assert.equal(headings.length, 1)
  assert.match(headings[0], /Settled/)
  const newer = await sidebar.getByText("Newer project chat", { exact: true }).boundingBox()
  const older = await sidebar.getByText("Older project chat", { exact: true }).boundingBox()
  assert.ok(newer.y < older.y)
  await sidebar.locator('[data-slot="sidebar-section-trigger"]').click()
  await sidebar.getByText("Finished project chat", { exact: true }).waitFor()
  await page.close()
})
