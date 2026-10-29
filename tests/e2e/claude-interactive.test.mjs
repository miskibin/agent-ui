import assert from "node:assert/strict"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { after, before, test } from "node:test"
import { startApp, loadPlaywright, launchChromium, ROOT } from "./server.mjs"

let app, browser
before(async () => {
  app = await startApp()
  browser = await launchChromium(await loadPlaywright())
  const settings = await (await fetch(`${app.baseUrl}/api/settings`)).json()
  settings.providers.claudeCode = { ...settings.providers.claudeCode, enabled: true,
    binPath: path.join(ROOT, "tests/stubs/claude-interactive.js"), workspace: app.folder, permissionMode: "edits" }
  assert.equal((await fetch(`${app.baseUrl}/api/settings`, { method: "PUT",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) })).status, 200)
})
after(async () => { await browser?.close(); await app?.stop() })

test("Claude approval, multi-select and image travel through the live UI in one turn", async () => {
  const { session } = await (await fetch(`${app.baseUrl}/api/sessions`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Claude interactive", providerId: "claudeCode", model: "sonnet", cwd: app.folder }) })).json()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(20000)
  await page.addInitScript((id) => localStorage.setItem("agent-ui:active-session", JSON.stringify(id)), session.id)
  await page.goto(app.baseUrl)
  const composer = page.locator('[data-slot="chat-input-textarea"]')
  await composer.waitFor()
  await page.locator('[data-slot="provider-picker-trigger"][aria-label="Provider: Claude Code"]').waitFor()
  const turns = []
  page.on("request", (request) => { if (request.url().endsWith("/api/chat")) turns.push(request.postDataJSON()) })
  await composer.fill("Run checks")
  await composer.press("Enter")
  const form = page.locator('[data-slot="pending-question"]')
  await form.getByText("echo permission", { exact: false }).waitFor()
  await form.getByRole("radio", { name: /Allow once/ }).click()
  await page.screenshot({ path: path.join(ROOT, ".github/screenshots/claude-approval.png") })
  await form.getByRole("button", { name: "Send", exact: true }).click()
  await form.getByRole("checkbox", { name: "Lint", exact: true }).click()
  await form.getByRole("checkbox", { name: "Tests", exact: true }).click()
  assert.equal(await page.locator('[data-slot="ask-question"]').count(), 1)
  await form.getByRole("button", { name: "Send", exact: true }).click()
  await page.getByText("same-turn: Lint, Tests; image=false", { exact: false }).first().waitFor()
  await page.locator('[data-slot="chat-input-stop"]').waitFor({ state: "detached" })
  assert.equal(turns.length, 1)
  await page.close()

  // The same real server/adapter accepts image blocks; answer over the shared respond API.
  const response = await fetch(`${app.baseUrl}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.id, prompt: "Review image", attachments: [{ id: "image", name: "pixel.png", mimeType: "image/png", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8WQAAAAASUVORK5CYII=" }] }) })
  let text = ""
  let buffer = ""
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    const decoded = decoder.decode(chunk, { stream: true })
    text += decoded
    buffer += decoded
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      if (line.slice(6).trim() === "[DONE]") continue
      const event = JSON.parse(line.slice(6))
      if (event.type !== "tool" || event.status !== "running" || !event.input || !["permission", "question"].includes(event.name)) continue
      const question = JSON.parse(event.input)
      if (!question.requestId) continue
      assert.equal((await fetch(`${app.baseUrl}/api/chat/respond`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, requestId: question.requestId,
          answer: question.kind === "permission" ? { optionId: "allow" } : { optionIds: ["0", "1"] } }) })).status, 200)
    }
  }
  assert.ok(text.includes("image=true"), text)
})

test("delegation inherits configuration and creates a persisted worktree without shell setup by the agent", { timeout: 30000 }, async () => {
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: app.folder, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git("init")
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial")
  const head = git("rev-parse", "HEAD")
  const { session } = await (await fetch(`${app.baseUrl}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Parent", providerId: "claudeCode", model: "sonnet", cwd: app.folder, permissionMode: "edits" }) })).json()
  const bridge = JSON.parse(await readFile(path.join(app.dataDir, "bridge.json"), "utf8"))
  const call = async (mode, args) => (await fetch(`${app.baseUrl}/api/mcp?parent=${session.id}&harness=claudeCode&model=sonnet&effort=high&mode=${mode}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_subagent", arguments: args } }),
  })).json()
  const denied = await call("read-only", { prompt: "Task", isolation: "worktree" })
  assert.equal(denied.result.isError, true)
  const response = await call("edits", { prompt: "inherit-check", isolation: "worktree", background: true })
  assert.equal(response.result.isError, undefined, JSON.stringify(response))
  const run = response.result.structuredContent
  assert.equal(run.harness, "claudeCode")
  assert.equal(run.model, "sonnet")
  const stream = await fetch(`${app.baseUrl}/api/subagents/${run.run_id}/stream`)
  const decoder = new TextDecoder()
  let buffer = "", output = ""
  for await (const chunk of stream.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data: ") || line.slice(6).trim() === "[DONE]") continue
      const event = JSON.parse(line.slice(6))
      if (event.type === "text") output += event.text
      if (event.type !== "tool" || event.status !== "running" || !event.input) continue
      const request = JSON.parse(event.input)
      if (!request.requestId) continue
      await fetch(`${app.baseUrl}/api/chat/respond`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: run.session_id, requestId: request.requestId,
          answer: request.kind === "permission" ? { optionId: "allow" } : { optionIds: ["0", "1"] } }) })
    }
  }
  assert.match(output, /same-turn: Lint, Tests/)
  const saved = await (await fetch(`${app.baseUrl}/api/sessions/${run.session_id}`)).json()
  assert.equal(saved.session.parentId, session.id)
  assert.equal(saved.session.cwd, saved.session.worktree.root)
  assert.notEqual(saved.session.cwd, app.folder)
  assert.equal(saved.session.worktree.baseBranch, git("branch", "--show-current"))
  assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: saved.session.cwd, encoding: "utf8" }).stdout.trim(), head)
})

test("a CLI exiting during approval cancels its form and removes the waiting request", { timeout: 15000 }, async () => {
  const { session } = await (await fetch(`${app.baseUrl}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Process exit", providerId: "claudeCode", model: "sonnet", cwd: app.folder }) })).json()
  const response = await fetch(`${app.baseUrl}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.id, prompt: "exit-while-waiting" }) })
  const text = await response.text()
  assert.match(text, /claude-request:p/)
  const expired = await fetch(`${app.baseUrl}/api/chat/respond`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.id, requestId: "claude-request:p", answer: { optionId: "allow" } }) })
  assert.equal(expired.status, 404)
  const saved = await (await fetch(`${app.baseUrl}/api/sessions/${session.id}`)).json()
  const tool = saved.messages.at(-1).tools.find((tool) => tool.id === "claude-request:p")
  assert.equal(tool.status, "error")
})

test("native background work keeps its control channel after an intermediate result", { timeout: 15000 }, async () => {
  const { session } = await (await fetch(`${app.baseUrl}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Background child", providerId: "claudeCode", model: "sonnet", cwd: app.folder }) })).json()
  const response = await fetch(`${app.baseUrl}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.id, prompt: "background-check" }) })
  let buffer = "", output = ""
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data: ") || line.slice(6).trim() === "[DONE]") continue
      const event = JSON.parse(line.slice(6))
      if (event.type === "text") output += event.text
      if (event.type !== "tool" || event.status !== "running" || !event.input) continue
      const request = JSON.parse(event.input)
      if (!request.requestId) continue
      await fetch(`${app.baseUrl}/api/chat/respond`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, requestId: request.requestId,
          answer: request.kind === "permission" ? { optionId: "allow" } : { optionIds: ["0", "1"] } }) })
    }
  }
  assert.match(output, /same-turn: Lint, Tests/)
  assert.match(output, /Child is working/)
})

test("the existing ACP approval contract still resumes the same turn", { timeout: 30000 }, async () => {
  const settings = await (await fetch(`${app.baseUrl}/api/settings`)).json()
  settings.providers.acp.agents.compat = { enabled: true, name: "ACP compatibility", kind: "generic",
    command: path.join(ROOT, "tests/stubs/acp-permission-agent.mjs"), args: [], env: {}, workspace: app.folder,
    permissionMode: "ask", dsh: { baseUrl: "", apiKey: "", sandbox: "read-only" } }
  assert.equal((await fetch(`${app.baseUrl}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings) })).status, 200)
  const { session } = await (await fetch(`${app.baseUrl}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "ACP compatibility", providerId: "acp:compat", cwd: app.folder }) })).json()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(20000)
  await page.addInitScript((id) => localStorage.setItem("agent-ui:active-session", JSON.stringify(id)), session.id)
  const turns = []
  page.on("request", (request) => { if (request.url().endsWith("/api/chat")) turns.push(request.postDataJSON()) })
  await page.goto(app.baseUrl)
  await page.locator('[data-slot="provider-picker-trigger"][aria-label="Provider: ACP compatibility"]').waitFor()
  const composer = page.locator('[data-slot="chat-input-textarea"]')
  await composer.fill("write hello.txt")
  await composer.press("Enter")
  const form = page.locator('[data-slot="pending-question"]')
  await form.getByRole("radio", { name: /Allow once/ }).click()
  await form.getByRole("button", { name: "Send", exact: true }).click()
  await page.locator('[data-slot="message"]', { hasText: "permission=allow" }).first().waitFor()
  await page.locator('[data-slot="chat-input-stop"]').waitFor({ state: "detached" })
  assert.equal(turns.length, 1)
  await page.close()
})
