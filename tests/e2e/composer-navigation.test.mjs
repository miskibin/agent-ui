import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { launchChromium, loadPlaywright, ROOT, startApp } from "./server.mjs"

let app, browser, page, project, other
const errors = []
const modelRequests = []
const validationRequests = []
const capabilities = { tools: true, resume: false, effort: true, vision: false }
const provider = (id, name) => ({ id, name, description: name, available: true, capabilities })
const catalogs = {
  mock: { providerId: "mock", models: [{ id: "mock-one", name: "Mock One" }], capabilities },
  pi: { providerId: "pi", models: [{ id: "pi-one", name: "Pi One" }, { id: "pi-two", name: "Pi Two" }], capabilities },
  codex: { providerId: "codex", models: [{ id: "codex-one", name: "Codex One" }], capabilities },
}
const activeSession = async () => {
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem("agent-ui:active-session") || '""'))
  const { sessions } = await (await fetch(`${app.baseUrl}/api/sessions`)).json()
  return sessions.find((session) => session.id === id)
}
const switchProvider = async (name) => {
  await page.locator('[data-slot="provider-picker-trigger"]').click()
  await page.locator('[data-slot="provider-picker-item"]').filter({ hasText: name }).click()
}
const card = () => page.locator('[data-slot="composer-model-card"]')
const openCard = () => page.getByRole("button", { name: "Choose model and reasoning", exact: true }).click()
const newChat = () => page.getByRole("button", { name: "New chat", exact: true }).last().click()

before(async () => {
  app = await startApp()
  project = app.folder
  other = path.join(app.workDir, "another-project")
  await mkdir(other)
  await writeFile(path.join(project, "package.json"), '{"name":"qa-project"}')
  await writeFile(path.join(other, "package.json"), '{"name":"another-project"}')
  const settings = await (await fetch(`${app.baseUrl}/api/settings`)).json()
  settings.providers.active = "mock"
  settings.chat.defaultEffort = "medium"
  settings.recentFolders = [project, other]
  await fetch(`${app.baseUrl}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) })
  browser = await launchChromium(await loadPlaywright())
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/api/providers", (route) => route.fulfill({ json: { providers: [provider("mock", "Mock agent"), provider("pi", "Pi"), provider("codex", "Codex")] } }))
  await page.route("**/api/models?*", async (route) => {
    const url = new URL(route.request().url())
    const id = url.searchParams.get("provider")
    modelRequests.push({ id, refresh: url.searchParams.get("refresh") })
    // Force the first Pi response to arrive after the next provider's response.
    if (id === "pi" && modelRequests.filter((request) => request.id === id).length === 1)
      await new Promise((resolve) => setTimeout(resolve, 1200))
    await route.fulfill({ json: catalogs[id] })
  })
  await page.route("**/api/fs/validate?*", async (route) => {
    const url = new URL(route.request().url())
    validationRequests.push(url.searchParams.get("git"))
    if (url.searchParams.get("git") !== "0")
      await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })
  await page.goto(app.baseUrl)
  await page.getByRole("button", { name: "Provider: Mock agent", exact: true }).waitFor()
  await page.getByRole("button", { name: "Choose model and reasoning", exact: true }).filter({ hasText: "Mock One" }).waitFor()
})
after(async () => { await browser?.close(); await app?.stop() })

test("new chat opens immediately with recent project icons and no folder, without scanning directories", async () => {
  const before = validationRequests.length
  const started = performance.now()
  await newChat()
  const dialog = page.getByRole("dialog", { name: "New chat", exact: true })
  await dialog.waitFor()
  assert.ok(performance.now() - started < 800)
  assert.equal(validationRequests.length, before)
  await dialog.getByRole("button", { name: "No folder", exact: true }).waitFor()
  await dialog.locator('[data-slot="folder-logo"][data-kind="monogram"]').first().waitFor()
  await page.screenshot({ path: path.join(ROOT, ".github/screenshots/new-chat-folders.png") })
  const selected = performance.now()
  await dialog.getByRole("button").filter({ hasText: project }).click()
  await dialog.waitFor({ state: "hidden" })
  assert.ok(performance.now() - selected < 1000, "git discovery must not delay project selection")
  assert.equal((await activeSession()).cwd, project)
  assert.ok(validationRequests.includes("0"))
})

test("provider changes clear old models immediately and ignore a late response from the previous provider", async () => {
  await switchProvider("Pi")
  await openCard()
  assert.doesNotMatch(await card().innerText(), /Mock One/)
  assert.match(await card().innerText(), /Loading models/)
  await page.keyboard.press("Escape")
  await switchProvider("Codex")
  await page.getByRole("button", { name: "Choose model and reasoning", exact: true }).filter({ hasText: "Codex One" }).waitFor()
  await new Promise((resolve) => setTimeout(resolve, 1300))
  await openCard()
  assert.match(await card().innerText(), /Codex One/)
  assert.doesNotMatch(await card().innerText(), /Pi One|Mock One/)
  await page.keyboard.press("Escape")
  assert.equal((await activeSession()).model, "codex-one")
  const before = modelRequests.filter((request) => request.id === "mock").length
  await switchProvider("Mock agent")
  await page.getByRole("button", { name: "Choose model and reasoning", exact: true }).filter({ hasText: "Mock One" }).waitFor()
  assert.equal(modelRequests.filter((request) => request.id === "mock").length, before, "returning to a loaded provider uses its catalog")
})

test("reasoning slider, model selection, and explicit refresh work in the compact model card", async () => {
  await switchProvider("Pi")
  await page.getByRole("button", { name: "Choose model and reasoning", exact: true }).filter({ hasText: "Pi One" }).waitFor()
  await openCard()
  const slider = card().getByRole("slider", { name: "Reasoning effort" })
  await slider.focus()
  await page.keyboard.press("ArrowRight")
  assert.equal(await slider.getAttribute("aria-valuetext"), "High")
  await card().locator('[data-slot="model-picker-trigger"]').click()
  await page.getByRole("menuitemradio").filter({ hasText: "Pi Two" }).click()
  await page.getByRole("button", { name: "Choose model and reasoning", exact: true }).filter({ hasText: "Pi Two" }).waitFor()
  const before = modelRequests.length
  await card().getByRole("button", { name: "Refresh models", exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh models"]')?.disabled)
  assert.equal(modelRequests.length, before + 1)
  assert.equal(modelRequests.at(-1).refresh, "1")
  await page.screenshot({ path: path.join(ROOT, ".github/screenshots/composer-model-card.png") })
  await page.keyboard.press("Escape")
})

test("sidebar hover stays clear and pin, snooze, delete remain in the context menu", async () => {
  const row = page.locator('[data-slot="sidebar-item-button"]').first()
  await row.hover()
  assert.equal(await page.locator('[data-slot="sidebar-item-actions"]').count(), 0)
  await row.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Pin", exact: true }).waitFor()
  await page.getByRole("menuitem", { name: "Delete", exact: true }).waitFor()
  await page.getByRole("menuitem", { name: "Snooze…", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: /^Snooze / })
  await dialog.getByRole("button", { name: /In 1 hour/ }).waitFor()
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
})

test("workspace collapses on a smaller screen, expands on demand, and no folder never reuses a project chat", async () => {
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.locator('[data-slot="workspace-panel"]').waitFor({ state: "hidden" })
  await page.getByRole("button", { name: "Toggle workspace panel", exact: true }).click()
  const dock = page.locator('[data-slot="workspace-dock"]')
  await dock.waitFor()
  assert.equal(await dock.getByRole("button", { name: "Open in editor", exact: true }).isVisible(), false)
  const box = await dock.boundingBox()
  assert.ok(box.height < 90)
  await page.screenshot({ path: path.join(ROOT, ".github/screenshots/workspace-compact.png") })
  await dock.getByRole("button", { name: "Expand workspace details", exact: true }).click()
  await dock.getByRole("button", { name: "Open in editor", exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.getByRole("button", { name: "Toggle workspace panel", exact: true }).click()
  await page.getByRole("button", { name: "Open chats", exact: true }).click()
  await page.getByRole("dialog", { name: "Chats", exact: true }).getByRole("button", { name: "New chat", exact: true }).last().click()
  await page.getByRole("dialog", { name: "New chat", exact: true }).waitFor()
  await page.getByRole("dialog", { name: "New chat", exact: true }).getByRole("button", { name: "No folder", exact: true }).click()
  await page.getByRole("dialog", { name: "New chat", exact: true }).waitFor({ state: "hidden" })
  assert.equal((await activeSession()).cwd ?? "", "")
  assert.deepEqual(errors, [])
})
