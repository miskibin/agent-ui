import assert from "node:assert/strict"
import { test } from "node:test"

import {
  CHARS_PER_TOKEN,
  estimateTokens,
  fitMessagesToContext,
} from "@/lib/token-estimate"

/**
 * What has to be true for a local model to answer at all. Ollama serves a
 * 4096-token window unless asked otherwise, and this app's small jobs — a
 * commit message from a 50k-character patch, a title from a long thread —
 * assemble far more than that. Sizing the window is `lib/completion.ts`'s
 * half; fitting what will not fit even then is this one's.
 */

function tokens(messages: { role: string; content: string }[]) {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
}

test("a prompt that already fits is handed back untouched", () => {
  const messages = [
    { role: "system", content: "Write a commit message." },
    { role: "user", content: "diff --git a/a b/a" },
  ]
  assert.equal(fitMessagesToContext(messages, 1_000), messages)
})

test("the longest message is what gets cut, and the rules survive", () => {
  const system = { role: "system", content: "Rules that must survive." }
  const user = { role: "user", content: "x".repeat(40 * CHARS_PER_TOKEN) }
  const fitted = fitMessagesToContext([system, user], 20)
  assert.equal(fitted[0].content, system.content, "the system prompt is untouched")
  assert.ok(fitted[1].content.length < user.content.length)
  assert.ok(tokens(fitted) <= 20, `fitted to ${tokens(fitted)} tokens`)
})

test("the cut is announced, not silent", () => {
  const fitted = fitMessagesToContext(
    [{ role: "user", content: "y".repeat(4_000) }],
    100
  )
  assert.match(fitted[0].content, /trimmed to fit the model's context window/)
  // The head is what survives: evidence in this app is assembled headline-first.
  assert.ok(fitted[0].content.startsWith("yyyy"))
})

test("two large messages both give ground", () => {
  const messages = [
    { role: "system", content: "a".repeat(8_000) },
    { role: "user", content: "b".repeat(8_000) },
  ]
  const fitted = fitMessagesToContext(messages, 500)
  assert.ok(tokens(fitted) <= 500, `fitted to ${tokens(fitted)} tokens`)
  assert.ok(fitted[0].content.length < 8_000)
  assert.ok(fitted[1].content.length < 8_000)
})

test("a budget of nothing is not a reason to send nothing", () => {
  const messages = [{ role: "user", content: "hello" }]
  assert.equal(fitMessagesToContext(messages, 0), messages)
})

test("the estimate is four characters to a token, trimmed", () => {
  assert.equal(estimateTokens(""), 0)
  assert.equal(estimateTokens("    "), 0)
  assert.equal(estimateTokens("abcd"), 1)
  assert.equal(estimateTokens("abcde"), 2)
})
