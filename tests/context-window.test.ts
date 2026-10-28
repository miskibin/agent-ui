import assert from "node:assert/strict"
import { test } from "node:test"

import { contextBreakdown, transcriptTokens } from "@/lib/context-breakdown"
import { catalogContextLength, publishedContextWindow } from "@/lib/model-context"

test("published windows match every spelling a harness uses", () => {
  assert.equal(publishedContextWindow("gpt-5"), 400_000)
  assert.equal(publishedContextWindow("openai/gpt-5-mini"), 400_000)
  assert.equal(publishedContextWindow("openai/gpt-5-chat-latest"), 128_000)
  assert.equal(publishedContextWindow("openrouter/anthropic/claude-sonnet-4.5"), 200_000)
  assert.equal(publishedContextWindow("sonnet"), 200_000)
  assert.equal(publishedContextWindow("claude-4.5-sonnet"), 200_000)
  assert.equal(publishedContextWindow("claude-sonnet-4-5[1m]"), 1_000_000)
  assert.equal(publishedContextWindow("gpt-4.1-mini"), 1_047_576)
  assert.equal(publishedContextWindow("chatgpt-4o-latest"), 128_000)
  assert.equal(publishedContextWindow("o1-mini"), 128_000)
  assert.equal(publishedContextWindow("o3"), 200_000)
  assert.equal(publishedContextWindow("google/gemini-2.5-pro"), 1_048_576)
  assert.equal(publishedContextWindow("xai/grok-4-fast-reasoning"), 2_000_000)
  assert.equal(publishedContextWindow("deepseek/deepseek-chat"), 128_000)
})

test("a local model or an unknown one gets no number rather than a guess", () => {
  assert.equal(publishedContextWindow("ollama/qwen3:8b"), undefined)
  assert.equal(publishedContextWindow("llama3.1:8b"), undefined)
  assert.equal(publishedContextWindow("composer-1"), undefined)
  assert.equal(publishedContextWindow(""), undefined)
  assert.equal(publishedContextWindow(undefined), undefined)
})

test("catalog entries are read under the field names hosts actually use", () => {
  assert.equal(catalogContextLength({ id: "x", context_length: 131072 }), 131072)
  assert.equal(catalogContextLength({ id: "x", context_window: "32768" }), 32768)
  assert.equal(catalogContextLength({ id: "x", max_context_length: 128000 }), 128000)
  assert.equal(catalogContextLength({ id: "x", context_length: 0 }), undefined)
  assert.equal(catalogContextLength({ id: "x" }), undefined)
  assert.equal(catalogContextLength(null), undefined)
})

test("the transcript counts text and tool traffic", () => {
  const messages = [
    { content: "a".repeat(400) },
    { content: "b".repeat(40), tools: [{ input: "c".repeat(40), output: "d".repeat(320) }] },
  ]
  assert.equal(transcriptTokens(messages), 200)
})

test("what the last turn carried is split into messages and what the harness adds", () => {
  const b = contextBreakdown({ prompt: 30_000, output: 2_000, conversation: 12_000, draft: 100, total: 200_000 })
  assert.deepEqual(
    b.segments.map((s) => [s.id, s.tokens]),
    [["setup", 20_000], ["messages", 12_000], ["draft", 100]]
  )
  assert.equal(b.used, 32_100)
  assert.equal(b.free, 167_900)
})

test("the estimate never exceeds the measurement it is carved from", () => {
  const b = contextBreakdown({ prompt: 5_000, output: 0, conversation: 9_000, draft: 0, total: 128_000 })
  assert.deepEqual(b.segments.map((s) => [s.id, s.tokens]), [["messages", 5_000]])
})

test("before any turn reports, only the estimate shows; nothing overflows the window", () => {
  const fresh = contextBreakdown({ prompt: 0, output: 0, conversation: 300, draft: 20, total: 1_000 })
  assert.deepEqual(fresh.segments.map((s) => s.id), ["messages", "draft"])
  const over = contextBreakdown({ prompt: 900, output: 400, conversation: 100, draft: 50, total: 1_000 })
  assert.equal(over.used, 1_000)
  assert.equal(over.free, 0)
})
