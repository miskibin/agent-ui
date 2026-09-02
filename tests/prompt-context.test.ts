import assert from "node:assert/strict"
import { test } from "node:test"

import { withPromptContext } from "@/lib/providers/system-prefix"

/**
 * The one place the two context mechanisms meet. They must stay two blocks in
 * one fixed order, and neither may ever be emitted twice or leak into what the
 * user is recorded as having typed.
 */

test("no context leaves the prompt exactly as typed", () => {
  assert.equal(withPromptContext("hello", {}), "hello")
  assert.equal(
    withPromptContext("hello", { standingContext: "  ", turnContext: "" }),
    "hello"
  )
})

test("memory alone is fenced as standing context", () => {
  assert.equal(
    withPromptContext("hello", { standingContext: "Prefers Polish." }),
    "<context>\nPrefers Polish.\n</context>\n\nhello"
  )
})

test("a handoff alone is fenced as its own block", () => {
  assert.equal(
    withPromptContext("hello", { turnContext: "cursor edited a.ts" }),
    "<handoff>\ncursor edited a.ts\n</handoff>\n\nhello"
  )
})

test("both appear once each, memory first, prompt last", () => {
  const composed = withPromptContext("hello", {
    standingContext: "Prefers Polish.",
    turnContext: "cursor edited a.ts",
  })
  assert.equal(
    composed,
    "<context>\nPrefers Polish.\n</context>\n\n<handoff>\ncursor edited a.ts\n</handoff>\n\nhello"
  )
  assert.equal(composed.match(/<context>/g)?.length, 1)
  assert.equal(composed.match(/<handoff>/g)?.length, 1)
  assert.ok(composed.indexOf("<context>") < composed.indexOf("<handoff>"))
  assert.ok(composed.endsWith("hello"))
})
