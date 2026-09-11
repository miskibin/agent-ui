import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { after, before, test } from "node:test"

import { launchChromium, loadPlaywright, startApp } from "./server.mjs"

/**
 * The review surface, against a real git worktree.
 *
 * Two regressions live here, and both were the same shape: content that
 * renders but cannot be reached. `@pierre/diffs` hangs its virtualizer off the
 * viewer's own root and reads `scrollTop` from it, so a viewer with no overflow
 * of its own is a file whose rows past the first screen do not exist for the
 * wheel. And a column of one viewer per file would be a column of *scrollers*,
 * which is the same dead end one file further down.
 *
 * So the assertions are about the scroll container: that there is exactly one
 * for the whole review, and that it moves.
 */

const UI_TIMEOUT = 30_000

let app
let browser
let session

before(async () => {
  app = await startApp()
  browser = await launchChromium(await loadPlaywright())

  const repo = app.folder
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" })
  try {
    git("init", "-b", "feat/review")
  } catch {
    /* already a repo */
  }
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  mkdirSync(path.join(repo, "backend"), { recursive: true })
  mkdirSync(path.join(repo, "frontend"), { recursive: true })
  const filler = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n"
  writeFileSync(path.join(repo, "backend", "store.py"), filler(80))
  writeFileSync(path.join(repo, "frontend", "banner.tsx"), filler(60))
  git("add", "-A")
  git("commit", "-m", "init")

  // Two edits and one untracked file — the state a chat's folder is usually in.
  writeFileSync(path.join(repo, "backend", "store.py"), `${filler(40)}def purge():\n    pass\n${filler(40)}`)
  writeFileSync(path.join(repo, "frontend", "banner.tsx"), `import React from "react"\n${filler(60)}`)
  writeFileSync(path.join(repo, "backend", "runs.py"), `${filler(30)}from .store import purge\n`)

  const created = await fetch(`${app.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Review", providerId: "mock", cwd: repo }),
  })
  ;({ session } = await created.json())
  await fetch(`${app.baseUrl}/api/sessions/${session.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { id: "u", sender: "user", content: "clean up the store" },
        {
          id: "a",
          sender: "assistant",
          content: "Done.",
          changes: [
            { path: "backend/store.py", additions: 2, deletions: 0, status: "modified" },
            { path: "frontend/banner.tsx", additions: 1, deletions: 0, status: "modified" },
            { path: "backend/runs.py", additions: 31, deletions: 0, status: "added" },
          ],
        },
      ],
    }),
  })
})

after(async () => {
  await browser?.close().catch(() => {})
  await app?.stop()
})

test("the diff route answers with a patch per file, untracked included", async () => {
  const res = await fetch(`${app.baseUrl}/api/git/diff?session=${session.id}`)
  assert.equal(res.status, 200)
  const { files } = await res.json()
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]))
  assert.ok(byPath["backend/store.py"]?.patch.includes("def purge"))
  assert.ok(byPath["frontend/banner.tsx"]?.patch.includes("import React"))
  // A file the agent created is untracked, and would be absent from a plain
  // `git diff` — the state a chat's changes are usually in.
  assert.equal(byPath["backend/runs.py"]?.status, "A")
  assert.ok(byPath["backend/runs.py"]?.patch.includes("from .store import purge"))
})

test("the whole review is one scroller, and it scrolls", async () => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } })
  await page.addInitScript(
    (id) => localStorage.setItem("agent-ui:active-session", id),
    session.id
  )
  await page.goto(app.baseUrl, { waitUntil: "domcontentloaded" })

  const trigger = page.locator('[aria-label*="files changed in this chat"]')
  await trigger.waitFor({ timeout: UI_TIMEOUT })
  await trigger.click()

  const panel = page.locator('[data-slot="changes-panel"]')
  await panel.waitFor({ timeout: UI_TIMEOUT })
  await page.locator('[data-slot="diff-stack-surface"]').waitFor({ timeout: UI_TIMEOUT })
  // The tree paints and the stack measures itself over a few frames.
  await page.waitForTimeout(4_000)

  // The file map sits beside the review rather than above it.
  const map = page.locator('[data-slot="changes-panel-map"]')
  await map.waitFor({ timeout: UI_TIMEOUT })
  const layout = await page.evaluate(() => {
    const tree = document.querySelector('[data-slot="changes-panel-map"]')
    const stack = document.querySelector('[data-slot="diff-stack-surface"]')
    if (!tree || !stack) return null
    const a = tree.getBoundingClientRect()
    const b = stack.getBoundingClientRect()
    return { treeRight: a.right, stackLeft: b.left, treeTop: a.top, stackTop: b.top }
  })
  assert.ok(layout, "the file map and the review are both on screen")
  assert.ok(
    layout.treeRight <= layout.stackLeft + 2,
    "the file tree sits beside the diffs, not above them"
  )
  assert.ok(
    Math.abs(layout.treeTop - layout.stackTop) < 40,
    "the file tree and the diffs share a row"
  )
  assert.ok(
    await page.evaluate(() => {
      const root = document.querySelector('[data-slot="changes-panel-map"]')
      if (!root) return false
      const parts = []
      const visit = (node) => {
        if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent || "")
        if (node.shadowRoot) visit(node.shadowRoot)
        for (const child of node.childNodes ?? []) visit(child)
      }
      visit(root)
      return parts.join(" ").includes("store.py")
    }),
    "changed files are listed in the tree"
  )

  const scrollers = await page.evaluate(() => {
    const surface = document.querySelector('[data-slot="diff-stack-surface"]')
    if (!surface) return []
    const found = []
    for (const node of surface.querySelectorAll("*")) {
      const style = getComputedStyle(node)
      if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2) {
        found.push({ height: node.clientHeight, content: node.scrollHeight })
      }
    }
    return found
  })
  assert.equal(
    scrollers.length,
    1,
    `the review is one scroller, not one per file (found ${scrollers.length})`
  )
  assert.ok(
    scrollers[0].content > scrollers[0].height,
    "and it has more content than it can show"
  )

  const top = () =>
    page.evaluate(() => {
      const surface = document.querySelector('[data-slot="diff-stack-surface"]')
      for (const node of surface?.querySelectorAll("*") ?? []) {
        if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node.scrollTop
      }
      return -1
    })

  assert.equal(await top(), 0)
  await page.locator('[data-slot="diff-stack-surface"]').hover()
  await page.mouse.wheel(0, 900)
  await page.waitForTimeout(700)
  assert.ok((await top()) > 0, "the wheel moves the review")

  await page.close()
})

test("a single file's viewer scrolls too", async () => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } })
  await page.addInitScript(
    (id) => localStorage.setItem("agent-ui:active-session", id),
    session.id
  )
  await page.goto(app.baseUrl, { waitUntil: "domcontentloaded" })

  const row = page.locator('[data-slot="change-summary-file"]').first()
  await row.waitFor({ timeout: UI_TIMEOUT })
  await row.click()
  await page.locator('[data-slot="file-preview-body"]').waitFor({ timeout: UI_TIMEOUT })
  await page.waitForTimeout(4_000)

  const top = () =>
    page.evaluate(() => {
      const surface = document.querySelector('[data-slot="diff-view-surface"]')
      for (const node of surface?.querySelectorAll("*") ?? []) {
        if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node.scrollTop
      }
      return -1
    })

  assert.equal(await top(), 0, "the file viewer has a scroll container")
  await page.locator('[data-slot="diff-view-surface"]').hover()
  await page.mouse.wheel(0, 900)
  await page.waitForTimeout(700)
  assert.ok((await top()) > 0, "and the wheel moves it")

  await page.close()
})
