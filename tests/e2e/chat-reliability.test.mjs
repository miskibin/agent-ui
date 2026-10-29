import assert from "node:assert/strict"
import { after, afterEach, before, test } from "node:test"
import path from "node:path"
import { startApp, launchChromium, loadPlaywright, ROOT } from "./server.mjs"

let app, browser
before(async () => {
  app = await startApp()
  browser = await launchChromium(await loadPlaywright())
})
afterEach(async () => {
  for (const context of browser?.contexts() ?? []) await context.close()
})
after(async () => {
  await browser?.close()
  await app?.stop()
})

async function createChat(title, messages = []) {
  const { session } = await (
    await fetch(`${app.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        providerId: "mock",
        model: "vision-model",
      }),
    })
  ).json()
  if (messages.length)
    await fetch(`${app.baseUrl}/api/sessions/${session.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    })
  return session
}

async function openChat(session) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(15000)
  await page.addInitScript(
    (id) => localStorage.setItem("agent-ui:active-session", JSON.stringify(id)),
    session.id
  )
  await page.route("**/api/models?*", (route) =>
    route.fulfill({
      json: {
        providerId: "mock",
        models: [{ id: "vision-model", label: "Vision model" }],
        capabilities: {
          vision: true,
          effort: true,
          permissionModes: ["read-only", "full"],
        },
        visionModels: ["vision-model"],
      },
    })
  )
  return page
}
const done = (route) =>
  route.fulfill({
    contentType: "text/event-stream",
    body: 'data: {"type":"done"}\n\n',
  })
const input = (page) => page.locator('[data-slot="chat-input-textarea"]')

test("commands survive queue rejection; Stop pauses the queue and Send now resumes it", async () => {
  const session = await createChat("Queue reliability")
  const page = await openChat(session)
  const requests = []
  await page.route("**/api/chat", (route) => {
    requests.push(route.request().postDataJSON())
    if (requests.length > 1) return done(route)
  })
  await page.goto(app.baseUrl)
  await input(page).fill("Start checking")
  await input(page).press("Enter")
  await page.locator('[data-slot="chat-input-stop"]').waitFor()
  await input(page).fill("/settings")
  await page.locator('[data-slot="chat-input-send"]').click()
  await page.waitForFunction(
    () =>
      document.querySelector('[data-slot="chat-input-textarea"]')?.value ===
      "/settings"
  )
  await input(page).fill("Check persistence next")
  await input(page).press("Enter")
  await page.locator('[data-slot="composer-queue-item"]').waitFor()
  await page.screenshot({
    path: path.join(ROOT, ".github/screenshots/chat-follow-ups.png"),
  })
  await page.locator('[data-slot="chat-input-stop"]').click()
  await page.getByText("Queue paused — send a message to continue").waitFor()
  assert.equal(requests.length, 1)
  const resumed = page.waitForResponse((response) =>
    response.url().endsWith("/api/chat")
  )
  await page.getByRole("button", { name: "Send now", exact: true }).click()
  await page.waitForFunction(
    () => !document.querySelector('[data-slot="composer-queue-item"]')
  )
  await resumed
  assert.equal(requests.length, 2)
  assert.equal(requests[1].prompt, "Check persistence next")
  await page.close()
})

test("Ctrl+Enter steers a running turn without discarding its transcript", async () => {
  const page = await openChat(await createChat("Steering reliability"))
  const requests = []
  await page.route("**/api/chat", (route) => {
    requests.push(route.request().postDataJSON())
    if (requests.length > 1) return done(route)
  })
  await page.goto(app.baseUrl)
  await input(page).fill("Start the task")
  await input(page).press("Enter")
  await page.locator('[data-slot="chat-input-stop"]').waitFor()
  await input(page).fill("Focus on the save error instead")
  const corrected = page.waitForResponse((response) =>
    response.url().endsWith("/api/chat")
  )
  await input(page).press("Control+Enter")
  await corrected
  assert.equal(requests.length, 2)
  assert.equal(requests[1].prompt, "Focus on the save error instead")
  assert.match(
    await page.locator('[data-slot="message-list"]').innerText(),
    /Start the task/
  )
  await page.close()
})

test("queued images and the original model survive a switch to another chat", async () => {
  const first = await createChat("Image queue origin")
  const second = await createChat("Image queue destination", [
    { id: "other-user", sender: "user", content: "Other project question" },
    {
      id: "other-assistant",
      sender: "assistant",
      content: "Other project answer",
    },
  ])
  const page = await openChat(first)
  const requests = []
  let finishFirst
  await page.route("**/api/chat", (route) => {
    requests.push(route.request().postDataJSON())
    if (requests.length === 1) finishFirst = () => done(route)
    else return done(route)
  })
  await page.goto(app.baseUrl)
  await input(page).fill("Start reviewing")
  await input(page).press("Enter")
  await page.locator('[data-slot="chat-input-stop"]').waitFor()
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "screen.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=",
        "base64"
      ),
    })
  await input(page).fill("Look at the screenshot")
  await input(page).press("Enter")
  await page.locator('[data-slot="composer-queue-item"]').waitFor()
  await page
    .locator('[data-slot="sidebar-item-button"]')
    .filter({ hasText: second.title })
    .first()
    .click()
  await page.waitForFunction(
    () => !document.querySelector('[data-slot="composer-queue-item"]')
  )
  const finished = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/chat") &&
      response.request().postDataJSON()?.prompt === "Look at the screenshot"
  )
  await finishFirst()
  await finished
  assert.equal(requests[1].sessionId, first.id)
  assert.equal(requests[1].model, "vision-model")
  assert.equal(requests[1].attachments[0].name, "screen.png")
  assert.match(requests[1].attachments[0].url, /^data:image\/png;base64,/)
  await page.close()
})

test("regeneration preserves attachments and requires confirmation before dropping later messages", async () => {
  const attachment = {
    id: "image",
    name: "screen.png",
    mimeType: "image/png",
    url: "data:image/png;base64,aGVsbG8=",
  }
  const messages = [
    {
      id: "u1",
      sender: "user",
      content: "Inspect this image",
      attachments: [attachment],
    },
    { id: "a1", sender: "assistant", content: "The first answer" },
    { id: "u2", sender: "user", content: "Follow-up question" },
    { id: "a2", sender: "assistant", content: "The second answer" },
  ]
  const session = await createChat("Regeneration reliability", messages)
  const page = await openChat(session)
  let sent
  await page.route("**/api/chat", (route) => {
    sent = route.request().postDataJSON()
    return done(route)
  })
  await page.goto(app.baseUrl)
  await page
    .getByRole("button", { name: "Regenerate", exact: true })
    .first()
    .click()
  await page
    .getByText("Regenerate this answer and remove the messages after it?")
    .waitFor()
  assert.equal(sent, undefined)
  assert.match(
    await page.locator('[data-slot="message-list"]').innerText(),
    /Follow-up question/
  )
  const finished = page.waitForResponse((response) =>
    response.url().endsWith("/api/chat")
  )
  await page
    .locator("[data-sonner-toast]")
    .getByRole("button", { name: "Regenerate", exact: true })
    .click()
  await finished
  assert.deepEqual(sent.attachments, [attachment])
  assert.doesNotMatch(
    await page.locator('[data-slot="message-list"]').innerText(),
    /Follow-up question/
  )
  await page.close()
})

test("a failed settings load cannot expose editable defaults and can be retried", async () => {
  const page = await browser.newPage()
  await page.route("**/api/settings", (route) =>
    route.fulfill({ status: 503, json: { error: "Offline" } })
  )
  await page.goto(`${app.baseUrl}/settings#chat`)
  await page
    .getByRole("alert")
    .filter({ hasText: "Could not load settings" })
    .waitFor()
  assert.equal(await page.getByRole("switch").count(), 0)
  await page.unroute("**/api/settings")
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await page
    .getByRole("alert")
    .filter({ hasText: "Could not load settings" })
    .waitFor({ state: "detached" })
  await page.getByRole("switch").first().waitFor()
  await page.close()
})

test("delete requires confirmation and a failed save keeps the message", async () => {
  const session = await createChat("Delete reliability", [
    {
      id: "delete-user",
      sender: "user",
      content: "Please inspect persistence",
    },
    {
      id: "delete-answer",
      sender: "assistant",
      content: "Keep this answer when saving fails",
    },
  ])
  const page = await openChat(session)
  await page.goto(app.baseUrl)
  await page
    .getByRole("button", { name: "Delete", exact: true })
    .first()
    .click()
  await page.getByText("Delete this message?", { exact: true }).waitFor()
  await page
    .getByText("Keep this answer when saving fails", { exact: true })
    .waitFor()
  await page.route(`**/api/sessions/${session.id}`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 503, json: { error: "Save is unavailable" } })
      : route.continue()
  )
  await page
    .locator("[data-sonner-toast]")
    .getByRole("button", { name: "Delete", exact: true })
    .click()
  await page.getByText("Save is unavailable", { exact: true }).waitFor()
  await page
    .getByText("Keep this answer when saving fails", { exact: true })
    .waitFor()
  await page.close()
})

test("clipboard rejection reports failure instead of Copied", async () => {
  const page = await openChat(
    await createChat("Clipboard reliability", [
      { id: "copy-user", sender: "user", content: "Check copying" },
      { id: "copy-answer", sender: "assistant", content: "Answer to copy" },
    ])
  )
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("Not allowed")) },
      configurable: true,
    })
  )
  await page.goto(app.baseUrl)
  await page.getByRole("button", { name: "Copy", exact: true }).first().click()
  await page
    .getByText("Could not copy. Check clipboard permissions and try again.", {
      exact: true,
    })
    .waitFor()
  assert.equal(
    await page
      .locator("[data-sonner-toast]")
      .getByText("Copied", { exact: true })
      .count(),
    0
  )
  await page.close()
})
