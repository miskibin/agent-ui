import assert from "node:assert/strict"
import path from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"

import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

/**
 * The mid-turn approval, end to end and without a model: a *generic* ACP agent
 * pointed at the stub under `tests/stubs/`, configured with the `ask` policy.
 * Everything below the browser is the real thing — the chat route, the ACP
 * transport, `lib/turn-requests`, `POST /api/chat/respond` — so this covers
 * the one path the vendored mock provider cannot produce.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STUB = path.join(HERE, "..", "stubs", "acp-permission-agent.mjs")
const UI_TIMEOUT = 30_000

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

async function configureStubAgent() {
  const settings = await (await fetch(`${app.baseUrl}/api/settings`)).json()
  settings.providers.acp.agents.stub = {
    enabled: true,
    name: "Stub agent",
    kind: "generic",
    command: STUB,
    args: [],
    env: {},
    workspace: app.folder,
    permissionMode: "ask",
    dsh: { baseUrl: "", apiKey: "", sandbox: "read-only" },
  }
  const saved = await fetch(`${app.baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  })
  assert.equal(saved.status, 200)
}

/**
 * Waits for one settled tool row, and says what the transcript actually held
 * when it never arrives — a stream that lost an event and a row that merely
 * scrolled away look identical from a timeout alone.
 */
async function expectToolRow(page, text) {
  await page
    .locator('[data-slot="message-tool-call"]', { hasText: text })
    .waitFor({ timeout: UI_TIMEOUT })
    .catch(async (error) => {
      const rows = await page.$$eval('[data-slot="message-tool-call"]', (nodes) =>
        nodes.map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
      )
      const transcript = await page
        .locator('[data-slot="message-list"]')
        .innerText()
        .catch(() => "<no message list>")
      error.message += [
        "",
        `rows: ${JSON.stringify(rows)}`,
        `transcript: ${transcript.slice(0, 600)}`,
      ].join("\n")
      throw error
    })
}

test("a running turn's permission request is answered above the composer", async () => {
  await configureStubAgent()

  const { session } = await (
    await fetch(`${app.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Approval round trip",
        providerId: "acp:stub",
        cwd: app.folder,
      }),
    })
  ).json()

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(
    (id) => localStorage.setItem("agent-ui:active-session", JSON.stringify(id)),
    session.id
  )
  await page.goto(app.baseUrl)

  const composer = page.locator('[data-slot="chat-input-textarea"]')
  await composer.waitFor({ state: "visible", timeout: UI_TIMEOUT })
  // A turn sent before the provider list lands names no backend.
  await page
    .locator('[data-slot="provider-picker-trigger"][aria-label="Provider: Stub agent"]')
    .waitFor({ timeout: UI_TIMEOUT })

  await composer.fill("write hello.txt")
  await composer.press("Enter")

  const form = page.locator('[data-slot="pending-question"]')
  await form.waitFor({ timeout: UI_TIMEOUT })

  // The turn is still running — that is the whole point of this form, so it
  // must be usable rather than disabled the way the ask form is.
  assert.equal(
    await page.locator('button[title="Stop generating"]').count(),
    1,
    "the turn is still generating while the form is up"
  )
  const allow = form.getByRole("radio", { name: "Allow once", exact: true })
  assert.equal(await allow.isDisabled(), false)

  // The transcript row says what it is waiting for, and offers no second form.
  const waiting = page.locator('[data-slot="message-tool-call"]', {
    hasText: "Waiting for your answer",
  })
  await waiting.waitFor({ timeout: UI_TIMEOUT })
  assert.equal(await page.locator('[data-slot="ask-question"]').count(), 1)

  const answered = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/chat/respond") &&
      response.request().method() === "POST"
  )
  await allow.click()
  await form.getByRole("button", { name: "Send", exact: true }).click()
  assert.equal((await answered).status(), 200)

  // The form goes, and the same row settles in place off the turn's own stream.
  await form.waitFor({ state: "detached", timeout: UI_TIMEOUT })
  await expectToolRow(page, "You allowed")
  await page
    .locator('[data-slot="message"]', { hasText: "permission=allow" })
    .waitFor({ timeout: UI_TIMEOUT })

  await page.close()
})

test("rejecting the request lets the turn finish without the tool", async () => {
  await configureStubAgent()

  const { session } = await (
    await fetch(`${app.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Approval refused",
        providerId: "acp:stub",
        cwd: app.folder,
      }),
    })
  ).json()

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(
    (id) => localStorage.setItem("agent-ui:active-session", JSON.stringify(id)),
    session.id
  )
  await page.goto(app.baseUrl)
  const composer = page.locator('[data-slot="chat-input-textarea"]')
  await composer.waitFor({ state: "visible", timeout: UI_TIMEOUT })
  await page
    .locator('[data-slot="provider-picker-trigger"][aria-label="Provider: Stub agent"]')
    .waitFor({ timeout: UI_TIMEOUT })
  await composer.fill("write hello.txt")
  await composer.press("Enter")

  const form = page.locator('[data-slot="pending-question"]')
  await form.waitFor({ timeout: UI_TIMEOUT })
  // "Deny" is the secondary action: no option named, the request cancelled.
  await form.getByRole("button", { name: "Deny", exact: true }).click()
  await form.waitFor({ state: "detached", timeout: UI_TIMEOUT })

  await expectToolRow(page, "You did not allow")

  await page
    .locator('[data-slot="message"]', { hasText: "permission=deny" })
    .waitFor({ timeout: UI_TIMEOUT })
  await page.close()
})
