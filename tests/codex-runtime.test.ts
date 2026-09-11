import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { hasCodexCredentials } from "@/lib/codex-runtime"

function withCodexHome(home: string, run: () => void) {
  const previous = {
    home: process.env.CODEX_HOME,
    openai: process.env.OPENAI_API_KEY,
    codex: process.env.CODEX_API_KEY,
  }
  process.env.CODEX_HOME = home
  delete process.env.OPENAI_API_KEY
  delete process.env.CODEX_API_KEY
  try {
    run()
  } finally {
    if (previous.home === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous.home
    if (previous.openai === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous.openai
    if (previous.codex === undefined) delete process.env.CODEX_API_KEY
    else process.env.CODEX_API_KEY = previous.codex
  }
}

test("a missing auth.json is a signed-out Codex install", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-ui-codex-auth-"))
  withCodexHome(home, () => {
    assert.equal(hasCodexCredentials(), false)
  })
})

test("ChatGPT tokens in auth.json count as a login", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-ui-codex-auth-"))
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({ tokens: { refresh_token: "rt-1" } })
  )
  withCodexHome(home, () => {
    assert.equal(hasCodexCredentials(), true)
  })
})

test("an API key in auth.json or the environment counts as a login", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-ui-codex-auth-"))
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-test" })
  )
  withCodexHome(home, () => {
    assert.equal(hasCodexCredentials(), true)
  })

  const empty = mkdtempSync(join(tmpdir(), "agent-ui-codex-auth-"))
  withCodexHome(empty, () => {
    process.env.OPENAI_API_KEY = "sk-env"
    assert.equal(hasCodexCredentials(), true)
  })
})
