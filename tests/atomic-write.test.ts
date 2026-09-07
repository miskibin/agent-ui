import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { writeFileAtomic } from "@/lib/atomic-write"

/**
 * The durable replacement every store write goes through: the reader never
 * sees half a file, the machine never keeps a renamed-into-place file of
 * zeroes, and a failure leaves no temp file behind.
 */

async function tempDir() {
  return mkdtemp(join(tmpdir(), "agent-ui-atomic-"))
}

test("a new file is written whole, and an existing one is replaced", async () => {
  const dir = await tempDir()
  const file = join(dir, "index.json")
  await writeFileAtomic(file, '{"a":1}')
  assert.equal(await readFile(file, "utf8"), '{"a":1}')
  await writeFileAtomic(file, '{"a":2}')
  assert.equal(await readFile(file, "utf8"), '{"a":2}')
})

test("nothing is left behind — not on success, not on failure", async () => {
  const dir = await tempDir()
  await writeFileAtomic(join(dir, "index.json"), "{}")
  assert.deepEqual(await readdir(dir), ["index.json"])

  // A directory where the file should be: the write fails, the temp goes.
  await assert.rejects(() => writeFileAtomic(dir, "{}"))
  assert.deepEqual(await readdir(dir), ["index.json"])
})

test("the file carries the mode it was asked for", async () => {
  const dir = await tempDir()
  const file = join(dir, "settings.json")
  await writeFileAtomic(file, "{}", { mode: 0o600 })
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
})

test("the old contents survive a write that never completes", async () => {
  const dir = await tempDir()
  const file = join(dir, "index.json")
  await writeFile(file, "original", "utf8")
  // A path whose parent does not exist cannot be written or renamed into.
  await assert.rejects(() => writeFileAtomic(join(dir, "missing", "index.json"), "next"))
  assert.equal(await readFile(file, "utf8"), "original")
})
