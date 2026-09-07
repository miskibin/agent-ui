import assert from "node:assert/strict"
import { test } from "node:test"

import { isLocalLoopbackHost, normalizeHostname } from "@/lib/host-classification"
import { isLoopbackOllamaUrl } from "@/lib/providers/ollama-autostart"

/**
 * Which hostnames name this machine — the question `ensureOllama` asks before
 * it is willing to spawn anything.
 */

test("brackets, case and a trailing dot are not part of a hostname", () => {
  assert.equal(normalizeHostname("[::1]"), "::1")
  assert.equal(normalizeHostname("LocalHost."), "localhost")
  assert.equal(normalizeHostname(" 127.0.0.1.. "), "127.0.0.1")
})

test("the whole of 127.0.0.0/8 is loopback, not just 127.0.0.1", () => {
  for (const host of [
    "localhost",
    "LOCALHOST.",
    "127.0.0.1",
    "127.1.2.3",
    "127.255.255.254",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ]) {
    assert.equal(isLocalLoopbackHost(host), true, host)
  }
})

test("anything that is not this machine is not loopback", () => {
  for (const host of [
    "",
    "128.0.0.1",
    "126.255.255.255",
    "10.0.0.1",
    "192.168.1.10",
    "0.0.0.0",
    "::",
    "::ffff:10.0.0.1",
    "127.0.0.1.evil.com",
    "notlocalhost",
    "example.com",
    "1270.0.0.1",
    "127.0.0.256",
  ]) {
    assert.equal(isLocalLoopbackHost(host), false, host)
  }
})

test("only an http URL naming this machine is ever spawned for", () => {
  assert.equal(isLoopbackOllamaUrl("http://127.5.5.5:11434"), true)
  assert.equal(isLoopbackOllamaUrl("http://[::1]:11434"), true)
  assert.equal(isLoopbackOllamaUrl("http://localhost:11434"), true)
  // Fail closed: TLS, a remote host and an unparseable URL are all "no".
  assert.equal(isLoopbackOllamaUrl("https://localhost:11434"), false)
  assert.equal(isLoopbackOllamaUrl("http://ollama.internal:11434"), false)
  assert.equal(isLoopbackOllamaUrl("not a url"), false)
})
