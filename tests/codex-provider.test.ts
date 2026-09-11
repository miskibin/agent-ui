import assert from "node:assert/strict"
import { test } from "node:test"

import { CodexClient } from "@/lib/codex-client"
import { createCodexProvider } from "@/lib/providers/codex"

test("info never starts app-server just to decide availability", async () => {
  let spawned = 0
  const original = CodexClient.spawn
  CodexClient.spawn = (() => {
    spawned += 1
    throw new Error("info() must not spawn Codex")
  }) as typeof CodexClient.spawn
  try {
    const provider = createCodexProvider({
      enabled: true,
      binPath: process.execPath,
      workspace: process.cwd(),
      permissionMode: "edits",
    })
    const info = await provider.info()
    assert.equal(spawned, 0)
    assert.equal(info.id, "codex")
    assert.equal(typeof info.available, "boolean")
  } finally {
    CodexClient.spawn = original
  }
})
