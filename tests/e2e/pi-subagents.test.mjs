import assert from "node:assert/strict"
import { createServer } from "node:http"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { startApp, loadPlaywright, launchChromium, ROOT } from "./server.mjs"

// Run with AGENT_UI_PI_TEST_BIN pointing at the installed Pi CLI's JS entry.
// Model responses are deterministic; the CLI, extensions, tools, bridge,
// storage, event streams and browser are real. No model account is needed.
describe("real Pi delegation", { skip: !process.env.AGENT_UI_PI_TEST_BIN }, () => {
  let app, browser, modelServer, releaseChild
  const modelCalls = []
  let serial = 0

  before(async () => {
    modelServer = createServer(async (req, res) => {
      if (req.url === "/v1/models") {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ data: [{ id: "parent-test" }, { id: "nemotron-test" }] }))
        return
      }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const request = JSON.parse(Buffer.concat(chunks).toString())
      modelCalls.push(request)
      const userIndex = request.messages.findLastIndex((message) => message.role === "user")
      const current = request.messages.slice(userIndex + 1)
      const toolResult = current.findLast((message) => message.role === "tool")
      const isChild = request.model === "nemotron-test"
      const userText = JSON.stringify(request.messages[userIndex].content)
      let tool, args, text
      if (isChild && !toolResult) {
        tool = "read"; args = { path: "review.ts" }
      } else if (isChild) {
        await new Promise((resolve) => { releaseChild = resolve })
        text = "Child review complete: division by zero needs a guard."
      } else if (!toolResult) {
        tool = "run_subagent"
        args = { prompt: "Read review.ts and report the bug.", model: "fixture/nemotron-test", title: "Nemotron code review",
          ...(userText.includes("background") ? { background: true } : {}) }
      } else {
        text = "Parent received the subagent receipt."
      }
      const id = `response-${++serial}`
      const base = { id, object: "chat.completion.chunk", created: 1, model: request.model }
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const delta = tool
        ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${serial}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] }
        : { role: "assistant", content: text }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`)
      res.end("data: [DONE]\n\n")
    })
    await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve))
    app = await startApp()
    await writeFile(path.join(app.folder, "review.ts"), "export const divide = (a: number, b: number) => a / b\n")
    const settings = await (await fetch(`${app.baseUrl}/api/settings`)).json()
    settings.providers.pi = { enabled: true, binPath: process.env.AGENT_UI_PI_TEST_BIN, workspace: app.folder }
    settings.providers.ollama = { enabled: false, baseUrl: "" }
    settings.modelProviders.fixture = { enabled: true, name: "Test models", apiKey: "fixture", models: [],
      baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1` }
    settings.chat.autoTitle = false
    settings.chat.generativeViews = false
    assert.equal((await fetch(`${app.baseUrl}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) })).status, 200)
    browser = await launchChromium(await loadPlaywright())
  })
  after(async () => {
    releaseChild?.()
    await browser?.close()
    await app?.stop()
    modelServer?.closeAllConnections()
    await new Promise((resolve) => modelServer ? modelServer.close(resolve) : resolve())
  })

  async function parent(title) {
    const { session } = await (await fetch(`${app.baseUrl}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, providerId: "pi", model: "fixture/parent-test", cwd: app.folder }) })).json()
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
    page.setDefaultTimeout(15000)
    await page.addInitScript((id) => localStorage.setItem("agent-ui:active-session", JSON.stringify(id)), session.id)
    await page.goto(app.baseUrl)
    await page.locator('[data-slot="provider-picker-trigger"][aria-label="Provider: pi"]').waitFor()
    return { session, page }
  }

  async function waitForChild() {
    for (let i = 0; i < 300; i++) {
      if (releaseChild) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Pi child never reached its real read tool: ${JSON.stringify(modelCalls.map((call) => ({ model: call.model, tools: call.tools?.map((tool) => tool.function.name) })))}`)
  }

  test("blocking delegation appears immediately, streams a real child, finishes without leaving cards in the answer", { timeout: 90000 }, async () => {
    const { session, page } = await parent("Pi extension review")
    await page.locator('[data-slot="chat-input-textarea"]').fill("Delegate a code review")
    await page.locator('[data-slot="chat-input-textarea"]').press("Enter")
    await waitForChild()
    const card = page.locator('[data-slot="subagent-card"]').filter({ hasText: "Nemotron code review" }).last()
    await card.and(page.locator('[data-status="running"]')).waitFor()
    // The receipt is visible while the parent is still waiting on this tool.
    const parentCall = modelCalls.find((call) => call.model === "parent-test")
    const childCall = modelCalls.find((call) => call.model === "nemotron-test")
    for (const name of ["run_subagent", "get_subagent", "wait_subagents", "message_subagent", "cancel_subagent", "list_models"])
      assert.ok(parentCall.tools.some((tool) => tool.function.name === name), name)
    assert.ok(childCall.tools.some((tool) => tool.function.name === "read"))
    assert.ok(!childCall.tools.some((tool) => tool.function.name === "run_subagent"), "children do not recursively delegate")
    await page.screenshot({ path: path.join(ROOT, ".github/screenshots/pi-subagent-running.png") })
    await card.click()
    await page.locator('[data-slot="message-list"]').getByText("Read review.ts and report the bug.", { exact: true }).waitFor()
    const sessions = (await (await fetch(`${app.baseUrl}/api/sessions`)).json()).sessions
    const child = sessions.find((item) => item.parentId === session.id)
    assert.equal(child.providerId, "pi")
    assert.equal(child.model, "fixture/nemotron-test")
    assert.equal(child.cwd, app.folder)
    const finish = releaseChild; releaseChild = undefined; finish()
    await page.getByText("Child review complete: division by zero needs a guard.", { exact: false }).first().waitFor()
    await page.getByRole("navigation", { name: "Agent navigation" }).getByRole("button", { name: session.title, exact: true }).click()
    await card.waitFor({ state: "detached" })
    await page.locator('[data-slot="chat-input-stop"]').waitFor({ state: "detached" })
    const saved = await (await fetch(`${app.baseUrl}/api/sessions/${session.id}`)).json()
    const tool = saved.messages.flatMap((message) => message.tools ?? []).find((tool) => tool.name === "run_subagent")
    assert.equal(tool.status, "done")
    assert.equal(JSON.parse(tool.output).status, "done")
    assert.equal(JSON.parse(tool.output).session_id, child.id)
    const childSaved = await (await fetch(`${app.baseUrl}/api/sessions/${child.id}`)).json()
    assert.ok(childSaved.messages.flatMap((message) => message.tools ?? []).some((tool) => tool.name === "read" && tool.output.includes("divide")))
    await page.reload()
    await card.waitFor({ state: "detached" })
    // Resuming the same Pi session must retain the installed tools too.
    await page.locator('[data-slot="chat-input-textarea"]').fill("Delegate another code review in background")
    await page.locator('[data-slot="chat-input-textarea"]').press("Enter")
    await waitForChild()
    await page.locator('[data-slot="chat-input-stop"]').waitFor({ state: "detached" })
    await card.and(page.locator('[data-status="running"]')).waitFor()
    const finishBackground = releaseChild; releaseChild = undefined; finishBackground()
    await page.locator('[data-slot="subagent-card"][data-status="running"]').waitFor({ state: "detached" })
    await page.close()
  })

  test("Stop in the child chat cancels the live task and updates the parent's card", { timeout: 90000 }, async () => {
    const { page, session } = await parent("Pi cancelled review")
    await page.locator('[data-slot="chat-input-textarea"]').fill("Delegate a background code review")
    await page.locator('[data-slot="chat-input-textarea"]').press("Enter")
    await waitForChild()
    const card = page.locator('[data-slot="subagent-card"]').filter({ hasText: "Nemotron code review" }).last()
    await card.and(page.locator('[data-status="running"]')).waitFor()
    await card.click()
    await page.locator('[data-slot="chat-input-stop"]').click()
    await page.getByRole("navigation", { name: "Agent navigation" }).getByRole("button", { name: session.title, exact: true }).click()
    await card.waitFor({ state: "detached" })
    releaseChild?.(); releaseChild = undefined
    await page.close()
  })

  test("stopping a blocking parent gives Pi time to cancel its child", { timeout: 90000 }, async () => {
    const { page } = await parent("Pi stopped parent")
    await page.locator('[data-slot="chat-input-textarea"]').fill("Delegate a blocking code review")
    await page.locator('[data-slot="chat-input-textarea"]').press("Enter")
    await waitForChild()
    const card = page.locator('[data-slot="subagent-card"]').filter({ hasText: "Nemotron code review" }).last()
    await card.and(page.locator('[data-status="running"]')).waitFor()
    await page.locator('[data-slot="chat-input-stop"]').click()
    await card.waitFor({ state: "detached" })
    releaseChild?.(); releaseChild = undefined
    await page.close()
  })
})
