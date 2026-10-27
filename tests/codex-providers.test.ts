import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"

import {
  codexProviderId,
  codexProviderOverrides,
  splitCodexModel,
} from "@/lib/codex-providers"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import type { ModelSource } from "@/lib/model-providers/server"
import { createCodexProvider } from "@/lib/providers/codex"
import { normalizeSettings } from "@/lib/settings/schema"

const litellm: ModelSource = {
  slug: "litellm",
  name: "LiteLLM",
  baseUrl: "http://127.0.0.1:4000/v1",
  apiKey: "sk-secret",
  models: ["gpt-5-mini"],
}
const openai: ModelSource = {
  slug: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  models: [],
}

test("each source becomes a namespaced Responses provider, its key in the environment", () => {
  const { args, env } = codexProviderOverrides([litellm, openai], "http://127.0.0.1:11434")
  assert.deepEqual(args, [
    "-c",
    'model_providers.agentui-ollama={ name = "Ollama", base_url = "http://127.0.0.1:11434/v1", wire_api = "responses" }',
    "-c",
    'model_providers.agentui-litellm={ name = "LiteLLM", base_url = "http://127.0.0.1:4000/v1", wire_api = "responses", env_key = "AGENT_UI_CODEX_KEY_LITELLM" }',
    "-c",
    'model_providers.agentui-openai={ name = "OpenAI", base_url = "https://api.openai.com/v1", wire_api = "responses" }',
  ])
  assert.deepEqual(env, { AGENT_UI_CODEX_KEY_LITELLM: "sk-secret" })
  assert.ok(!args.join(" ").includes("sk-secret"), "the key never reaches argv")
  assert.deepEqual(codexProviderOverrides([], ""), { args: [], env: {} })
})

test("a composite id picks its source's provider; Codex's own ids stay bare", () => {
  assert.deepEqual(splitCodexModel("litellm/qwen/qwen3-coder", [litellm], false), {
    provider: codexProviderId("litellm"),
    model: "qwen/qwen3-coder",
  })
  assert.deepEqual(splitCodexModel("ollama/qwen3:8b", [], true), {
    provider: "agentui-ollama",
    model: "qwen3:8b",
  })
  assert.deepEqual(splitCodexModel("gpt-5.1-codex", [litellm], true), { model: "gpt-5.1-codex" })
  assert.deepEqual(splitCodexModel("groq/llama", [litellm], false), { model: "groq/llama" })
})

/* A fake `codex app-server` that logs how it was started and what the thread asked for. */
const scratch = mkdtempSync(path.join(tmpdir(), "agent-ui-codex-"))
const fakeCodex = path.join(scratch, "codex.js")
const logPath = path.join(scratch, "log.json")
writeFileSync(
  fakeCodex,
  `
const fs = require("node:fs")
const log = { argv: process.argv.slice(2), key: process.env.AGENT_UI_CODEX_KEY_LITELLM ?? null, requests: [] }
const save = () => fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(log))
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method) { log.requests.push({ method: m.method, params: m.params }); save() }
    if (m.method === "initialize") send({ id: m.id, result: {} })
    else if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "th-1" } } })
    else if (m.method === "turn/start") {
      send({ id: m.id, result: { turn: { id: "tu-1" } } })
      send({ method: "item/agentMessage/delta", params: { itemId: "i1", delta: "ok" } })
      send({ method: "turn/completed", params: { turn: { id: "tu-1", status: "completed", durationMs: 5 } } })
    }
  }
})
setTimeout(() => {}, 60000)
`
)
after(() => rmSync(scratch, { recursive: true, force: true }))

test("a turn on a model provider declares it at startup and picks it on the thread", async () => {
  const settings = normalizeSettings({
    providers: { ollama: { enabled: false } },
    modelProviders: { litellm: { enabled: true, name: "LiteLLM", baseUrl: litellm.baseUrl, apiKey: "sk-secret" } },
  })
  const provider = createCodexProvider(
    { enabled: true, binPath: fakeCodex, workspace: scratch, permissionMode: "full" },
    settings
  )
  const events: AgentStreamEvent[] = []
  for await (const event of provider.run({
    prompt: "hi",
    model: "litellm/gpt-5-mini",
    signal: new AbortController().signal,
  })) {
    events.push(event)
  }
  assert.equal(events.at(-1)?.type, "done", JSON.stringify(events))
  const log = JSON.parse(readFileSync(logPath, "utf8")) as {
    argv: string[]
    key: string | null
    requests: Array<{ method: string; params: Record<string, unknown> }>
  }
  assert.equal(log.argv[0], "app-server")
  assert.ok(log.argv.some((arg) => arg.startsWith("model_providers.agentui-litellm=")))
  assert.equal(log.key, "sk-secret")
  const start = log.requests.find((request) => request.method === "thread/start")
  assert.equal(start?.params.modelProvider, "agentui-litellm")
  assert.equal(start?.params.model, "gpt-5-mini")
  const turn = log.requests.find((request) => request.method === "turn/start")
  assert.equal(turn?.params.model, "gpt-5-mini")
})
