import assert from "node:assert/strict"
import { test } from "node:test"

import type { ModelSource } from "@/lib/model-providers/server"
import {
  TINYAGENT_DEFAULT_MODEL,
  argsForceReadOnly,
  tinyagentTurn,
} from "@/lib/tinyagent-config"

const source = (slug: string, baseUrl: string, apiKey = "key"): ModelSource => ({
  slug,
  name: slug,
  baseUrl,
  apiKey,
  models: [],
})

const sources = [
  source("openai", "https://api.openai.com/v1"),
  source("anthropic", "https://api.anthropic.com/v1"),
  source("openrouter", "https://openrouter.ai/api/v1"),
  source("litellm", "http://localhost:4000/v1", ""),
]

test("the default model leaves the choice to tinyagent's own config", () => {
  const turn = tinyagentTurn({ model: TINYAGENT_DEFAULT_MODEL, sources, ollamaBaseUrl: "" })
  assert.deepEqual(turn.args, ["--acp", "--plan"])
  assert.deepEqual(turn.env, {})
})

test("built-in sources keep their spelling and their key", () => {
  const turn = tinyagentTurn({ model: "anthropic/claude-sonnet-4-5", sources, ollamaBaseUrl: "" })
  assert.deepEqual(turn.args, ["--acp", "--plan", "-m", "anthropic/claude-sonnet-4-5"])
  assert.deepEqual(turn.env, { ANTHROPIC_API_KEY: "key" })
})

test("any other OpenAI-compatible source is tinyagent's openai provider at that URL", () => {
  const turn = tinyagentTurn({
    model: "litellm/qwen/qwen3-coder",
    effort: "high",
    permissionMode: "read-only",
    sources,
    ollamaBaseUrl: "http://127.0.0.1:11434",
  })
  assert.deepEqual(turn.args, [
    "--acp",
    "--plan",
    "-m",
    "openai/qwen/qwen3-coder",
    "--openai-api",
    "chat",
    "--reasoning-effort",
    "high",
    "--read-only",
  ])
  assert.equal(turn.env.OPENAI_BASE_URL, "http://localhost:4000/v1")
  assert.equal(turn.env.OPENAI_API_KEY, "none")
  assert.equal(turn.env.OLLAMA_HOST, "http://127.0.0.1:11434")
})

test("a model whose source is gone is an error, not a silent fallback", () => {
  assert.match(
    tinyagentTurn({ model: "groq/llama", sources, ollamaBaseUrl: "" }).error ?? "",
    /groq/
  )
  assert.match(
    tinyagentTurn({ model: "ollama/qwen3", sources, ollamaBaseUrl: "" }).error ?? "",
    /Ollama/
  )
})

test("--read-only in the user's own flags pins the agent read-only", () => {
  assert.ok(argsForceReadOnly(["--read-only"]))
  assert.ok(!argsForceReadOnly(["--read-only", "--read-only=false"]))
  assert.ok(!argsForceReadOnly(["--sandbox"]))
})
