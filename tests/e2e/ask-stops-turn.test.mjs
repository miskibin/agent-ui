import assert from "node:assert/strict"
import { after, before, test } from "node:test"

import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

/**
 * A question is a stop sign.
 *
 * The harnesses this app drives cannot all block on their own ask tool: they
 * ask and carry on, so a form that waited for the turn to end would be a form
 * the agent had already answered for itself. Answering has to work *while* the
 * turn generates, and it has to stop it.
 *
 * The two things a regression here would hide: the answer reaching the stored
 * transcript at all, and the running turn actually being cut off rather than
 * left streaming into the message the answer was just written onto.
 */

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

const ASK = {
  id: "ask-scope",
  name: "AskQuestion",
  status: "running",
  input: JSON.stringify({
    questions: [
      {
        id: "scope",
        prompt: "What should the fix plan target?",
        options: [
          { id: "minimal", label: "Finish the minimal layout" },
          { id: "revert", label: "Revert to the old layout" },
        ],
      },
    ],
  }),
}

test("a question is answerable mid-turn, and answering stops the turn", async () => {
  const created = await fetch(`${app.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Empty chat scope", providerId: "mock" }),
  })
  const { session } = await created.json()
  await fetch(`${app.baseUrl}/api/sessions/${session.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { id: "request", sender: "user", content: "Fix the empty chat." },
        { id: "reply", sender: "assistant", content: "Looking.", tools: [ASK] },
      ],
    }),
  })

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript(
    (id) => localStorage.setItem("agent-ui:active-session", id),
    session.id
  )

  /**
   * A turn that never ends on its own, so the only thing that can stop it is
   * the answer. The first `/api/chat` hangs with the ask open; the second —
   * the turn the answer sends — completes at once, which is what lets the
   * assertions below run without waiting on a real model.
   */
  let turns = 0
  let hangingRoute = null
  await page.route("**/api/chat", (route) => {
    turns += 1
    if (turns === 1) {
      hangingRoute = route
      // Headers only: the stream stays open with nothing on it.
      return
    }
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'data: {"type":"done"}\n\n',
    })
  })

  await page.goto(app.baseUrl)
  const composer = page.locator('[data-slot="chat-input-textarea"]')
  await composer.waitFor({ timeout: 30_000 })
  await composer.fill("go on then")
  await composer.press("Enter")

  // The turn is running: the composer offers Stop rather than Send.
  const stop = page.locator('[data-slot="chat-input-stop"]')
  await stop.waitFor({ timeout: 30_000 })
  assert.equal(turns, 1, "the first turn reached the route")

  // The question is live *while* that turn generates — the whole point.
  const question = page.locator('[data-slot="pending-question"]')
  await question.waitFor({ timeout: 30_000 })
  const radio = question.getByRole("radio", {
    name: "Finish the minimal layout",
    exact: true,
  })
  await radio.waitFor({ timeout: 30_000 })
  assert.equal(
    await radio.isEnabled(),
    true,
    "the form is answerable while the turn generates"
  )

  const persisted = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/sessions/${session.id}`) &&
      response.request().method() === "PUT"
  )
  await radio.click()
  await question.getByRole("button", { name: "Continue", exact: true }).click()
  assert.equal((await persisted).status(), 200)

  // The first turn was cut off and a second one carries the answer.
  await question.waitFor({ state: "detached", timeout: 30_000 })
  assert.equal(turns, 2, "answering sent the answer as a turn of its own")
  // …and nothing is generating any more: the composer is back to Send.
  await stop.waitFor({ state: "detached", timeout: 30_000 })
  await page
    .locator('[data-slot="chat-input-send"]')
    .waitFor({ timeout: 30_000 })

  const stored = await (
    await fetch(`${app.baseUrl}/api/sessions/${session.id}`)
  ).json()
  const reply = stored.messages.find((message) => message.id === "reply")
  const answer = JSON.parse(reply.tools[0].output)
  assert.deepEqual(answer.answers.scope.optionIds, ["minimal"])
  assert.equal(answer.source, "user")

  await hangingRoute?.abort().catch(() => {})
  await page.close()
})
