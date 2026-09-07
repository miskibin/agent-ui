import assert from "node:assert/strict"
import { test } from "node:test"

import { extractJsonObject, parseJsonObject } from "@/lib/json-rescue"

/**
 * What a small model asked for JSON actually returns, and what has to survive
 * it: a preamble, a fence, a trailing sentence, and braces inside strings.
 */

test("a bare object is returned unchanged", () => {
  assert.equal(extractJsonObject('{"a":1}'), '{"a":1}')
})

test("a preamble, a fence and a trailing sentence are all peeled off", () => {
  for (const raw of [
    'Here is the JSON: {"title":"Fix the parser"}',
    '```json\n{"title":"Fix the parser"}\n```',
    '{"title":"Fix the parser"}\n\nLet me know if you want another.',
    'Sure!\n```\n{"title":"Fix the parser"}\n```\nDone.',
  ]) {
    assert.deepEqual(parseJsonObject(raw), { title: "Fix the parser" }, raw)
  }
})

test("a brace inside a string does not end the scan", () => {
  assert.deepEqual(parseJsonObject('note: {"text":"a } and a \\" quote","n":1} trailing'), {
    text: 'a } and a " quote',
    n: 1,
  })
})

test("nesting is balanced, not first-brace-to-first-close", () => {
  assert.equal(
    extractJsonObject('x {"a":{"b":{"c":2}},"d":3} y'),
    '{"a":{"b":{"c":2}},"d":3}'
  )
})

test("no object at all leaves the input alone, and parses to nothing", () => {
  assert.equal(extractJsonObject("  Fix the parser  "), "Fix the parser")
  assert.equal(parseJsonObject("Fix the parser"), undefined)
})

test("a truncated object fails the parse rather than pretending", () => {
  assert.equal(extractJsonObject('{"title":"Fix'), '{"title":"Fix')
  assert.equal(parseJsonObject('{"title":"Fix'), undefined)
})
