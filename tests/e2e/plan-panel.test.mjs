import assert from "node:assert/strict"
import { after, before, test } from "node:test"

import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

/**
 * A plan belongs in the panel, not in the message column.
 *
 * A plan is the one thing in a transcript that is a proposal rather than a
 * record: it is read, argued with, then acted on. In the column it was a card
 * at whatever width the column happened to be, and a long one had to be
 * scrolled past to reach anything else.
 *
 * What a regression would hide: the panel opening on its own when the agent
 * writes one, Build living in its header and *only* there — one plan must not
 * carry two buttons that start the same turn — a dismissal that sticks, and
 * the panel standing down once the conversation has moved past the plan.
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

const PLAN_BODY = [
  "## Steps",
  "",
  "1. Read `lib/artifact_store.py` and find the delete path.",
  "2. Add a unit test for `_delete_artifact_files`.",
  "3. Wire the cleanup into the settle hook.",
].join("\n")

function planMessage(id, toolId) {
  return {
    id,
    sender: "assistant",
    content: "Here is what I propose.",
    parts: [
      { type: "text", text: "Here is what I propose." },
      {
        type: "tool",
        tool: {
          id: toolId,
          name: "ExitPlanMode",
          status: "done",
          input: JSON.stringify({
            name: "Artifact store cleanup",
            overview: "Delete orphaned artifact files when a run settles.",
            plan: PLAN_BODY,
          }),
        },
      },
    ],
  }
}

async function openChat(page, messages, title) {
  const created = await fetch(`${app.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, providerId: "mock" }),
  })
  const { session } = await created.json()
  await fetch(`${app.baseUrl}/api/sessions/${session.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  })
  await page.addInitScript(
    (id) => localStorage.setItem("agent-ui:active-session", id),
    session.id
  )
  await page.goto(app.baseUrl)
  await page.locator('[data-slot="chat-input-textarea"]').waitFor({ timeout: 30_000 })
  return session
}

test("the newest plan opens in the panel, with Build in its header", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await openChat(
    page,
    [
      { id: "u1", sender: "user", content: "Plan the artifact store cleanup." },
      planMessage("a1", "plan-1"),
    ],
    "Artifact store cleanup"
  )

  const panel = page.locator('[data-slot="plan-panel"]')
  await panel.waitFor({ timeout: 30_000 })
  await panel
    .locator('[data-slot="plan-panel-title"]')
    .filter({ hasText: "Artifact store cleanup" })
    .waitFor({ timeout: 30_000 })
  // The markdown is rendered, not printed: the plan's own list is real markup.
  assert.ok(
    (await panel.locator("ol li, ul li").count()) >= 3,
    "the plan body renders as markdown"
  )

  // Build is in the panel header…
  await panel.locator('[data-slot="plan-panel-build"]').waitFor({ timeout: 30_000 })
  // …and nowhere else: the transcript's card keeps the plan as that turn's
  // record but must not offer a second button that starts the same turn.
  assert.equal(
    await page.locator('[data-slot="plan-card-build"]').count(),
    0,
    "the transcript card no longer offers Build"
  )

  // The transcript keeps the plan's *place* in the thread, not a second copy:
  // the row is its header alone, and the body lives only in the panel.
  const row = page.locator('[data-slot="plan-card"][data-compact="true"]')
  await row.waitFor({ timeout: 30_000 })
  assert.equal(
    await row.locator('[data-slot="plan-card-body"]').count(),
    0,
    "the collapsed row carries no second copy of the plan"
  )

  // A dismissal sticks rather than being undone by the next render.
  await panel.locator('[data-slot="plan-panel-close"]').click()
  await panel.waitFor({ state: "detached", timeout: 30_000 })
  await page.waitForTimeout(1_000)
  assert.equal(await panel.count(), 0, "the panel stays closed")

  // …and the row is the way back to it.
  await row.locator('[data-slot="plan-card-header"]').click()
  await panel.waitFor({ timeout: 30_000 })

  await page.close()
})

test("a plan the conversation has moved past does not reopen", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await openChat(
    page,
    [
      { id: "u1", sender: "user", content: "Plan it." },
      planMessage("a1", "plan-1"),
      { id: "u2", sender: "user", content: "Actually, do something else." },
      { id: "a2", sender: "assistant", content: "Done." },
    ],
    "Moved on"
  )
  await page.waitForTimeout(2_000)
  assert.equal(
    await page.locator('[data-slot="plan-panel"]').count(),
    0,
    "a plan two turns back is history, not a proposal"
  )
  await page.close()
})
