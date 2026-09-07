import assert from "node:assert/strict"
import { test } from "node:test"

import { MAX_TITLE_CHARS, sanitizeTitle } from "@/lib/completion"

/**
 * What "Regenerate title" stores, out of whatever the model actually said.
 * The JSON is unwrapped before anything is truncated — the other order leaves
 * a chat called `{"title": "Fix the streaming rec`.
 */

test("a JSON answer is unwrapped, fenced or not", () => {
  assert.equal(sanitizeTitle('{"title":"Fix the parser"}'), "Fix the parser")
  assert.equal(sanitizeTitle('```json\n{"title":"Fix the parser"}\n```'), "Fix the parser")
  assert.equal(
    sanitizeTitle('Here you go: {"title":"Fix the parser"} — hope that helps.'),
    "Fix the parser"
  )
})

test("a plain answer is cleaned the way it always was", () => {
  assert.equal(sanitizeTitle('  "Fix the parser."  '), "Fix the parser")
  assert.equal(sanitizeTitle("Title: Fix the parser"), "Fix the parser")
  assert.equal(sanitizeTitle("Fix the parser\nand also the lexer"), "Fix the parser")
  assert.equal(sanitizeTitle("Fix   the    parser"), "Fix the parser")
  assert.equal(sanitizeTitle("   "), "")
})

test("a long JSON title is unwrapped first and only then trimmed", () => {
  const long = "Fix the streaming reconnect loop in the desktop shell sidebar"
  const cleaned = sanitizeTitle(JSON.stringify({ title: long }))
  assert.ok(cleaned.length <= MAX_TITLE_CHARS)
  assert.ok(cleaned.startsWith("Fix the streaming reconnect loop"))
  assert.ok(!cleaned.includes("{"))
})
