import assert from "node:assert/strict"
import { after, before, test } from "node:test"

import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

/**
 * Notes: a markdown file the person writes and an agent works in.
 *
 * What a regression would hide: the WYSIWYG editor not drawing Mermaid, the
 * ask bubble not reaching the agent, the agent's pending placeholder and its
 * finished edit not landing live in the open editor, the thread not carrying
 * the reply — and, the one that loses work, the person's own typing during an
 * agent edit being overwritten instead of merged. The mock harness drives the
 * real `/api/mcp?note=` tools, so the guard and the merge are the real ones.
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

const NOTE = [
  "# Login service",
  "",
  "The client posts credentials to the gateway, which checks them against the user store.",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Client] --> B[Gateway]",
  "```",
  "",
  "Tokens expire after an hour.",
  "",
].join("\n")

async function createNote(content) {
  const res = await fetch(`${app.baseUrl}/api/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  })
  assert.equal(res.status, 201)
  return (await res.json()).meta
}

async function readNote(id) {
  return (await fetch(`${app.baseUrl}/api/notes/${id}`)).json()
}

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript(() =>
    localStorage.setItem("agent-ui:note-agent", JSON.stringify({ providerId: "mock", model: "composer-2.5" }))
  )
  await page.goto(app.baseUrl)
  return page
}

/** Selects `text` inside the editor the way a person drags over it. */
async function selectText(page, text) {
  await page.evaluate((needle) => {
    const root = document.querySelector("[data-slot=note-editor] .ProseMirror")
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const at = node.textContent.indexOf(needle)
      if (at >= 0) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        root.focus()
        return
      }
    }
    throw new Error(`"${needle}" is not in the editor`)
  }, text)
  // ProseMirror reads the DOM selection on selectionchange.
  await page.waitForTimeout(150)
}

test("a note opens from the sidebar in the WYSIWYG editor with Mermaid drawn", async () => {
  const meta = await createNote(NOTE)
  const page = await openPage()
  try {
    await page.getByRole("button", { name: /Login service/ }).first().click()
    await page.locator("[data-slot=note-editor][data-ready=true]").waitFor({ timeout: 20_000 })
    await page.locator("[data-slot=note-editor] h1", { hasText: "Login service" }).waitFor()
    await page.locator("[data-slot=note-editor-mermaid] svg").first().waitFor({ timeout: 20_000 })
    assert.equal(await page.locator("[data-slot=app-header-note]").getByText("Login service").count(), 1)
    assert.ok(meta.id)
  } finally {
    await page.close()
  }
})

test("asking about a selection plants a pending block, fills it live and replies in the thread", async () => {
  const meta = await createNote(NOTE)
  const page = await openPage()
  try {
    await page.getByRole("button", { name: /Login service/ }).first().click()
    await page.locator("[data-slot=note-editor][data-ready=true]").waitFor({ timeout: 20_000 })
    const before = await page.locator("[data-slot=note-editor-mermaid] svg").count()

    await selectText(page, "posts credentials to the gateway")
    // The selection follows into the composer on its own.
    await page.locator("[data-slot=note-composer-selection]", { hasText: "posts credentials to the gateway" }).waitFor()
    const input = page.locator("[data-slot=note-composer-input]")
    await input.fill("Add a diagram of this flow")
    // Focus left the editor; the selected words stay marked.
    await page.locator("[data-slot=note-editor-held-selection]").waitFor()
    await input.press("Enter")
    await page.locator("[data-slot=note-composer-selection]").waitFor({ state: "detached" })

    // The thread appears with the selected words, and the words are marked.
    await page.locator("[data-slot=note-thread]", { hasText: "Add a diagram of this flow" }).waitFor()
    await page.locator("[data-slot=note-editor-anchor]").first().waitFor()
    // The placeholder lands first, live…
    await page.locator("[data-slot=note-editor-pending]").waitFor({ timeout: 15_000 })
    // …then the diagram replaces it.
    await page.locator("[data-slot=note-editor-pending]").waitFor({ state: "detached", timeout: 15_000 })
    await page.waitForFunction(
      (count) => document.querySelectorAll("[data-slot=note-editor-mermaid] svg").length > count,
      before,
      { timeout: 15_000 }
    )
    await page
      .locator("[data-slot=note-thread-message][data-author=agent]", { hasText: "Added it right after" })
      .waitFor({ timeout: 15_000 })

    const saved = await readNote(meta.id)
    const blocks = saved.content.split("\n\n")
    const paragraph = blocks.findIndex((block) => block.includes("posts credentials"))
    assert.match(blocks[paragraph + 1], /^```mermaid\nflowchart LR/)
    assert.ok(!saved.content.includes("agent-pending"))
    assert.equal(saved.threads[0].status, "done")
    await page.screenshot({ path: process.env.NOTES_SCREENSHOT ?? "/tmp/notes-e2e.png" })
  } finally {
    await page.close()
  }
})

test("typing while the agent edits keeps both", async () => {
  const meta = await createNote(NOTE)
  const page = await openPage()
  try {
    await page.getByRole("button", { name: /Login service/ }).first().click()
    await page.locator("[data-slot=note-editor][data-ready=true]").waitFor({ timeout: 20_000 })

    await selectText(page, "posts credentials to the gateway")
    await page.locator("[data-slot=note-composer-selection]").waitFor()
    const input = page.locator("[data-slot=note-composer-input]")
    await input.fill("Add a table")
    await input.press("Enter")
    await page.locator("[data-slot=note-editor-pending]").waitFor({ timeout: 15_000 })

    // While the agent is mid-edit, the person keeps writing elsewhere.
    await page.locator("[data-slot=note-editor] p", { hasText: "Tokens expire" }).click()
    await page.keyboard.press("End")
    await page.keyboard.type(" Refresh happens silently.", { delay: 20 })

    await page
      .locator("[data-slot=note-thread-message][data-author=agent]")
      .first()
      .waitFor({ timeout: 20_000 })
    // Let the last save settle.
    await page.locator("[data-slot=note-save-state][data-state=saved]").waitFor({ timeout: 10_000 })
    await page.waitForTimeout(800)

    const saved = await readNote(meta.id)
    assert.match(saved.content, /Tokens expire after an hour\. Refresh happens silently\./)
    // The editor respells the table it saves (padded columns): match the words.
    assert.match(saved.content, /\|\s*Item\s*\|\s*Note\s*\|/)
    assert.ok(!saved.content.includes("agent-pending"))
    const editorText = await page.locator("[data-slot=note-editor] .ProseMirror").innerText()
    assert.match(editorText, /Refresh happens silently\./)
    assert.match(editorText, /Drafted by the mock agent/)
  } finally {
    await page.close()
  }
})

test("the note keeps the app header and asks about the whole note without a selection", async () => {
  const meta = await createNote(NOTE)
  const page = await openPage()
  try {
    await page.getByRole("button", { name: /Login service/ }).first().click()
    await page.locator("[data-slot=note-editor][data-ready=true]").waitFor({ timeout: 20_000 })
    // The title sits where a chat's breadcrumbs do, and the note's controls
    // live in the header's own actions — one header, no second bar.
    await page.locator("[data-slot=app-header] [data-slot=app-header-note]", { hasText: "Login service" }).waitFor()
    await page.locator("[data-slot=app-header] [data-slot=note-header-controls]").waitFor()
    assert.equal(await page.locator("[data-slot=note-workspace-header]").count(), 0)
    // No floating formatting toolbar over a selection.
    await selectText(page, "Tokens expire")
    assert.equal(await page.locator(".milkdown-toolbar[data-show=true]").count(), 0)
    // Right-click offers the host's action above the clipboard.
    await page.locator("[data-slot=note-editor] p", { hasText: "Tokens expire" }).click({ button: "right" })
    await page.locator("[data-slot=note-editor-action]", { hasText: "Ask the agent" }).waitFor()
    await page.keyboard.press("Escape")
    // Nothing selected: the ask is about the note as a whole.
    await page.locator("[data-slot=note-editor] h1").click()
    await page.locator("[data-slot=note-composer-selection]").waitFor({ state: "detached" })
    const input = page.locator("[data-slot=note-composer-input]")
    await input.fill("Add a summary table")
    await input.press("Enter")
    await page
      .locator("[data-slot=note-thread-message][data-author=agent]", { hasText: "Added it" })
      .waitFor({ timeout: 20_000 })
    const saved = await readNote(meta.id)
    assert.match(saved.content, /Drafted by the mock agent/)
    assert.equal(saved.threads[0].anchor, "")
  } finally {
    await page.close()
  }
})

test("an agent edit to a block the person changed is refused, not written over it", async () => {
  const meta = await createNote(NOTE)
  const tokenFile = await import("node:fs/promises").then((fs) =>
    fs.readFile(`${app.dataDir}/bridge.json`, "utf8")
  )
  const { token } = JSON.parse(tokenFile)
  const call = async (name, args) => {
    const res = await fetch(`${app.baseUrl}/api/mcp?parent=s&note=${meta.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    })
    return (await res.json()).result
  }
  const read = await call("note_read", {})
  const paragraph = read.structuredContent.blocks.find((block) => block.markdown.includes("posts credentials"))
  // The person edits that paragraph after the agent read it.
  const current = await readNote(meta.id)
  await fetch(`${app.baseUrl}/api/notes/${meta.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: current.content.replace("user store.", "user store over TLS."),
      baseRev: current.meta.rev,
      base: current.content,
    }),
  })
  const refused = await call("note_edit", { ops: [{ op: "replace", id: paragraph.id, markdown: "Agent's older version." }] })
  assert.equal(refused.isError, true)
  const after = await readNote(meta.id)
  assert.match(after.content, /over TLS\./)
  assert.ok(!after.content.includes("older version"))
})

test("images pasted into a note are stored in the vault and served back", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64"
  )
  const form = new FormData()
  form.set("file", new File([png], "pixel.png", { type: "image/png" }))
  const res = await fetch(`${app.baseUrl}/api/notes/assets`, { method: "POST", body: form })
  const { src } = await res.json()
  assert.match(src, /^assets\/[a-f0-9]{12}-pixel\.png$/)
  const served = await fetch(`${app.baseUrl}/api/notes/${src}`)
  assert.equal(served.status, 200)
  assert.equal(served.headers.get("content-type"), "image/png")
  assert.equal(Buffer.from(await served.arrayBuffer()).length, png.length)
})
