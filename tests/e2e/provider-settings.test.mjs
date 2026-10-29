import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { createServer } from "node:http"
import path from "node:path"

import { launchChromium, loadPlaywright, ROOT, startApp } from "./server.mjs"

let app, browser, page, catalog
let catalogUrl
let catalogFailure = false
let catalogRequests = []
const uiErrors = []

before(async () => {
  catalog = createServer((req, res) => {
    catalogRequests.push(req.url)
    res.writeHead(catalogFailure ? 503 : 200, {
      "content-type": "application/json",
    })
    res.end(
      JSON.stringify(
        catalogFailure
          ? { error: "Offline" }
          : { data: [{ id: "qa-model" }, { id: "qa-model-2" }] }
      )
    )
  })
  await new Promise((resolve) => catalog.listen(0, "127.0.0.1", resolve))
  catalogUrl = `http://127.0.0.1:${catalog.address().port}/v1`
  app = await startApp()
  const settings = await (await fetch(`${app.baseUrl}/api/settings`)).json()
  for (const key of ["pi", "cursorAgent", "claudeCode", "codex", "ollama"])
    settings.providers[key].enabled = false
  for (const agent of Object.values(settings.providers.acp.agents))
    agent.enabled = false
  settings.providers.active = "mock"
  await fetch(`${app.baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  })
  browser = await launchChromium(await loadPlaywright())
  page = await browser.newPage({
    viewport: { width: 1440, height: 1060 },
    reducedMotion: "reduce",
  })
  page.on("pageerror", (error) => uiErrors.push(error.message))
  await page.goto(`${app.baseUrl}/settings#providers`)
  await page
    .getByRole("button", { name: "Configure pi", exact: true })
    .waitFor()
})

after(async () => {
  await page?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.stop()
  await new Promise((resolve) => catalog?.close(resolve))
})

const row = (id) =>
  page.locator(`[data-slot="provider-row"][data-provider-id="${id}"]`)

test("harnesses start compact with icons and disabled providers are not called unreachable", async () => {
  await row("pi").getByText("Disabled", { exact: true }).waitFor()
  assert.equal(await page.locator('[data-slot="provider-row"]').count(), 8)
  assert.equal(
    await page.locator('[data-slot="provider-details"]:visible').count(),
    0
  )
  assert.ok(
    (await page.locator('[data-slot="provider-row"] [data-brand]').count()) >= 6
  )
  assert.match(await row("pi").innerText(), /Disabled/)
  assert.doesNotMatch(
    await page.locator('[data-slot="settings-panel"]').innerText(),
    /Unreachable|Agentic harness|subprocess/
  )
  await page.screenshot({
    animations: "disabled",
    path: path.join(ROOT, ".github/screenshots/provider-settings.png"),
  })
})

test("configuration and setup commands are accessible from the provider row", async () => {
  const configure = page.getByRole("button", {
    name: "Configure pi",
    exact: true,
  })
  await configure.click()
  assert.equal(await configure.getAttribute("aria-expanded"), "true")
  assert.ok(
    await page
      .getByRole("link", { name: "Install pi", exact: true })
      .isVisible()
  )
  assert.ok(
    await page
      .getByRole("button", {
        name: "Copy npm install -g @mariozechner/pi-coding-agent",
        exact: true,
      })
      .isVisible()
  )
  assert.ok(
    await page
      .getByRole("textbox", { name: "pi binary path", exact: true })
      .isVisible()
  )
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await page
    .getByRole("button", {
      name: "Copy npm install -g @mariozechner/pi-coding-agent",
      exact: true,
    })
    .click()
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "npm install -g @mariozechner/pi-coding-agent"
  )
  assert.doesNotMatch(await row("pi").innerText(), /enter \/login/)
  await configure.press("Enter")
  assert.equal(await configure.getAttribute("aria-expanded"), "false")
  await page
    .getByRole("button", { name: "Configure Codex", exact: true })
    .click()
  assert.ok(
    await page
      .getByRole("button", { name: "Copy codex login", exact: true })
      .isVisible()
  )
  await page
    .getByText("Command copied.", { exact: true })
    .waitFor({ state: "hidden" })
  await page.screenshot({
    animations: "disabled",
    path: path.join(ROOT, ".github/screenshots/codex-settings.png"),
  })
  await page
    .getByRole("button", { name: "Configure Codex", exact: true })
    .click()
})

test("provider refresh rechecks status, reloads available models and settles its spinner", async () => {
  const statuses = []
  const models = []
  page.on("request", (req) => {
    const url = new URL(req.url())
    if (url.pathname === "/api/providers") statuses.push(url.search)
    if (url.pathname === "/api/models") models.push(url.search)
  })
  await page
    .getByRole("button", { name: "Refresh provider status", exact: true })
    .click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Refresh provider status"]')
        .getAttribute("aria-busy") === "false"
  )
  assert.ok(statuses.includes("?refresh=1"))
  assert.ok(models.includes("?provider=mock&refresh=1"))
  assert.equal(
    await page
      .getByRole("button", { name: "Refresh provider status", exact: true })
      .isEnabled(),
    true
  )
})

test("model refresh waits for an autosave already in flight and probes the newly typed endpoint", async () => {
  await page.getByRole("link", { name: "Model providers", exact: true }).click()
  await page
    .getByRole("button", { name: "Configure OpenAI", exact: true })
    .click()
  await page.getByRole("switch", { name: "Enable OpenAI", exact: true }).click()
  // Leave enough time for the debounce to start the PUT, then keep the actual
  // write in flight while Refresh is clicked. The probe must await that PUT.
  let releaseWrite
  let writeStarted
  const started = new Promise((resolve) => {
    writeStarted = resolve
  })
  const release = new Promise((resolve) => {
    releaseWrite = resolve
  })
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "PUT") return route.continue()
    writeStarted()
    await release
    await route.continue()
  })
  await page
    .getByRole("textbox", { name: "OpenAI base URL", exact: true })
    .fill(catalogUrl)
  await started
  const pendingProbe = page.waitForRequest(
    (req) => new URL(req.url()).pathname === "/api/model-providers/probe"
  )
  await page
    .getByRole("button", { name: "Refresh OpenAI", exact: true })
    .click()
  assert.equal(
    await page
      .getByRole("button", { name: "Refresh OpenAI", exact: true })
      .getAttribute("aria-busy"),
    "true"
  )
  releaseWrite()
  await pendingProbe
  await row("openai").getByText("2 models available", { exact: true }).waitFor()
  await page.unroute("**/api/settings")
  assert.ok(catalogRequests.includes("/v1/models"))
  assert.equal(
    await page
      .getByRole("button", { name: "Refresh OpenAI", exact: true })
      .getAttribute("aria-busy"),
    "false"
  )
})

test("failed catalog checks display an error and can be retried", async () => {
  catalogFailure = true
  await page
    .getByRole("button", { name: "Refresh OpenAI", exact: true })
    .click()
  await row("openai").getByText("Check failed", { exact: true }).waitFor()
  assert.match(await row("openai").innerText(), /503/)
  catalogFailure = false
  await page
    .getByRole("button", { name: "Refresh OpenAI", exact: true })
    .click()
  await row("openai").getByText("2 models available", { exact: true }).waitFor()
  await page
    .getByRole("textbox", { name: "OpenAI model ids", exact: true })
    .fill("manual-model")
  await page
    .getByRole("textbox", { name: "OpenAI model ids", exact: true })
    .press("Tab")
  await row("openai").getByText("Not checked", { exact: true }).waitFor()
  await page
    .getByRole("button", { name: "Refresh OpenAI", exact: true })
    .click()
  await row("openai").getByText("1 model available", { exact: true }).waitFor()
})

test("a failed save blocks refresh instead of checking the old settings", async () => {
  let probes = 0
  const onRequest = (req) => {
    if (new URL(req.url()).pathname === "/api/model-providers/probe")
      probes += 1
  }
  page.on("request", onRequest)
  await page.route("**/api/settings", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, body: "Save failed" })
      : route.continue()
  )
  await page
    .getByRole("textbox", { name: "OpenAI base URL", exact: true })
    .fill(`${catalogUrl}/changed`)
  await page
    .getByRole("button", { name: "Refresh OpenAI", exact: true })
    .click()
  await page.getByText("Couldn't save settings.", { exact: true }).waitFor()
  assert.equal(probes, 0)
  await page.unroute("**/api/settings")
  page.off("request", onRequest)
  await page
    .getByRole("textbox", { name: "OpenAI base URL", exact: true })
    .fill(catalogUrl)
  await page
    .getByRole("button", { name: "Refresh OpenAI", exact: true })
    .click()
  await row("openai").getByText("1 model available", { exact: true }).waitFor()
  await page
    .getByRole("button", { name: "Configure OpenAI", exact: true })
    .click()
  await page
    .getByText("Couldn't save settings.", { exact: true })
    .waitFor({ state: "hidden" })
  await page.screenshot({
    animations: "disabled",
    path: path.join(ROOT, ".github/screenshots/model-provider-settings.png"),
  })
})

test("provider settings persist and the compact layout fits mobile", async () => {
  await page.reload()
  await page
    .getByRole("button", { name: "Configure OpenAI", exact: true })
    .click()
  assert.equal(
    await page
      .getByRole("textbox", { name: "OpenAI base URL", exact: true })
      .inputValue(),
    catalogUrl
  )
  assert.equal(
    await page
      .getByRole("switch", { name: "Enable OpenAI", exact: true })
      .getAttribute("aria-checked"),
    "true"
  )
  await page.setViewportSize({ width: 390, height: 844 })
  for (const section of ["Model providers", "Harnesses"]) {
    await page
      .getByRole("link", { name: section, exact: true })
      .filter({ visible: true })
      .click()
    const sizes = await page.evaluate(() => ({
      width: innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }))
    assert.ok(
      sizes.document <= sizes.width && sizes.body <= sizes.width,
      JSON.stringify(sizes)
    )
  }
  await page.getByRole("button", { name: "Configure pi", exact: true }).click()
  const sizes = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
  }))
  assert.ok(sizes.document <= sizes.width, JSON.stringify(sizes))
  assert.deepEqual(uiErrors, [])
})
