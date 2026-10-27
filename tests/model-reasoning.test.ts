import assert from "node:assert/strict"
import { test } from "node:test"

import {
  hostedEffortModels,
  looksReasoningCapableId,
  rememberEffortRejected,
} from "@/lib/model-reasoning"

test("reasoning families are recognized by id", () => {
  for (const id of [
    "openai/o3-mini",
    "openai/gpt-5.1",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-3-7-sonnet-latest",
    "google/gemini-2.5-pro",
    "deepseek/deepseek-reasoner",
    "xai/grok-4",
    "groq/qwen/qwen3-32b",
    "litellm/qwq-32b",
    "openrouter/openai/gpt-oss-120b",
  ]) {
    assert.ok(looksReasoningCapableId(id), id)
  }
  for (const id of [
    "openai/gpt-4o",
    "anthropic/claude-3-5-haiku-latest",
    "groq/llama-3.3-70b-versatile",
    "together/qwen/qwen3-coder-480b",
    "mistral/mistral-large-latest",
    "openai/text-embedding-3-small",
  ]) {
    assert.ok(!looksReasoningCapableId(id), id)
  }
})

test("a model whose endpoint refused the field stops being offered it", () => {
  const ids = ["litellm/gpt-5-mini", "litellm/gpt-4o"]
  assert.deepEqual(hostedEffortModels(ids), ["litellm/gpt-5-mini"])
  rememberEffortRejected("litellm/gpt-5-mini")
  assert.deepEqual(hostedEffortModels(ids), [])
})
