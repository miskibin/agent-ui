import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { resolveInRoot } from "@/lib/fs-search"

/**
 * The repair behind every clickable file in a chat: an agent names a file the
 * way it thinks of it, and this has to turn that into a file on disk without
 * ever guessing between two equally good candidates.
 */

let root = ""

const write = (relative: string, text = "x") => {
  const full = join(root, ...relative.split("/"))
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, text)
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "fs-search-"))
  write("frontend/app/globals.css")
  write("frontend/app/components/Messages.tsx")
  write("frontend/app/components/ToolCall.tsx")
  write("frontend/app/lib/utils.ts")
  write("backend/lib/utils.ts")
  write("node_modules/pkg/Messages.tsx")
})

after(() => rmSync(root, { recursive: true, force: true }))

test("a path that resolves against the root is taken as it stands", async () => {
  const found = await resolveInRoot(root, "frontend/app/globals.css")
  assert.ok(found)
  assert.equal(found.exact, true)
  assert.equal(found.relative, "frontend/app/globals.css")
})

test("a bare file name resolves when exactly one file carries it", async () => {
  const found = await resolveInRoot(root, "Messages.tsx")
  assert.ok(found)
  assert.equal(found.exact, false)
  assert.equal(found.relative, "frontend/app/components/Messages.tsx")
})

test("a path that is only a suffix of the real one resolves", async () => {
  const found = await resolveInRoot(root, "components/ToolCall.tsx")
  assert.ok(found)
  assert.equal(found.relative, "frontend/app/components/ToolCall.tsx")
})

test("the deeper suffix wins over a shallower name match", async () => {
  const found = await resolveInRoot(root, "app/lib/utils.ts")
  assert.ok(found)
  assert.equal(found.relative, "frontend/app/lib/utils.ts")
})

test("two equally good candidates resolve to nothing rather than a guess", async () => {
  assert.equal(await resolveInRoot(root, "utils.ts"), null)
})

test("a name nothing carries resolves to nothing", async () => {
  assert.equal(await resolveInRoot(root, "Nowhere.tsx"), null)
})

test("windows separators and a leading ./ are the same path", async () => {
  const found = await resolveInRoot(root, ".\\frontend\\app\\globals.css")
  assert.ok(found)
  assert.equal(found.relative, "frontend/app/globals.css")
})
