import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

import { writePiSubagentExtension } from "@/lib/pi-extension"
import { PI_SUBAGENT_SOURCE } from "@/lib/pi-subagents"
import { TOOL_DEFINITIONS } from "@/lib/subagents/mcp"

type Result = { content: { type: string; text: string }[]; details: Record<string, unknown> }
type Tool = { name: string; execute(id: string, params: Record<string, unknown>, signal?: AbortSignal, update?: (result: Result) => void): Promise<Result> }

function load(url?: string) {
  const tools = new Map<string, Tool>()
  const hooks = new Map<string, (event: { systemPrompt: string }) => { systemPrompt: string }>()
  // Only the host-provided schema package is substituted here. The generated
  // extension itself executes unchanged against a real HTTP bridge below.
  const Type = new Proxy({}, { get: () => (...args: unknown[]) => ({ args }) })
  const source = stripTypeScriptTypes(PI_SUBAGENT_SOURCE
    .replace('import { Type } from "typebox"', "")
    .replace("export default function", "function"))
  const factory = runInNewContext(`${source}\nsubagents`, {
    Type, fetch, AbortSignal, Date,
    process: { env: { AGENT_UI_MCP_URL: url, AGENT_UI_MCP_HEADERS: JSON.stringify({ Authorization: "Bearer test-token" }) } },
  })
  factory({ registerTool: (tool: Tool) => tools.set(tool.name, tool),
    on: (name: string, hook: (event: { systemPrompt: string }) => { systemPrompt: string }) => hooks.set(name, hook) })
  return { tools, hooks }
}

test("Pi automatically installs and repairs its subagent extension without storing credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagents-"))
  try {
    const path = await writePiSubagentExtension(dir)
    assert.equal(await readFile(path, "utf8"), PI_SUBAGENT_SOURCE)
    const original = (await stat(path)).mtimeMs
    assert.equal(await writePiSubagentExtension(dir), path)
    assert.equal((await stat(path)).mtimeMs, original)
    await writeFile(path, "outdated extension")
    await writePiSubagentExtension(dir)
    assert.equal(await readFile(path, "utf8"), PI_SUBAGENT_SOURCE)
    assert.ok(!PI_SUBAGENT_SOURCE.includes("test-token"))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("Pi exposes all bridge tools and reminds resumed sessions; child chats get none", () => {
  const { tools, hooks } = load("http://127.0.0.1/api/mcp?parent=p")
  assert.deepEqual([...tools.keys()], TOOL_DEFINITIONS.map((tool) => tool.name))
  assert.match(hooks.get("before_agent_start")!({ systemPrompt: "Existing instructions" }).systemPrompt, /^Existing instructions\n\n.*run_subagent/)
  assert.equal(load().tools.size, 0)
})

test("Pi delegates through the scoped bridge, publishes the child receipt, waits and propagates errors", async () => {
  const requests: { name: string; arguments: Record<string, unknown> }[] = []
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/api/mcp?parent=p&harness=pi&model=local%2Fqwen&mode=full")
    assert.equal(req.headers.authorization, "Bearer test-token")
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const message = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(message.params)
    const name = message.params.name
    const data = { run_id: "r1", session_id: "child", status: name === "get_subagent" ? "done" : "running", answer: name === "get_subagent" ? "Review complete" : undefined }
    const result = name === "list_models"
      ? { isError: true, content: [{ type: "text", text: "Unknown harness" }] }
      : { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] }
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address() as { port: number }
    const { tools } = load(`http://127.0.0.1:${address.port}/api/mcp?parent=p&harness=pi&model=local%2Fqwen&mode=full`)
    const updates: Result[] = []
    const done = await tools.get("run_subagent")!.execute("call", { prompt: "Review files", model: "ollama/nemotron", title: "Review" }, undefined, (update) => updates.push(update))
    assert.equal(requests[0].arguments.background, true)
    assert.equal(requests[0].arguments.model, "ollama/nemotron")
    assert.equal(updates[0].details.session_id, "child")
    assert.equal(updates[0].details.status, "running")
    assert.equal(done.details.status, "done")
    assert.equal(done.details.answer, "Review complete")
    assert.equal(requests[1].name, "get_subagent")
    assert.equal(requests[1].arguments.session_id, "child")
    requests.length = 0
    const background = await tools.get("run_subagent")!.execute("call", { prompt: "Task", background: true })
    assert.equal(background.details.status, "running")
    assert.equal(requests.length, 1, "a background launch does not wait")
    await assert.rejects(tools.get("list_models")!.execute("call", { harness: "missing" }), /Unknown harness/)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test("stopping Pi cancels a blocking child instead of leaving it running", async () => {
  let cancelled = false
  const abort = new AbortController()
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const message = JSON.parse(Buffer.concat(chunks).toString())
    const name = message.params.name
    if (name === "get_subagent") { abort.abort(); return }
    if (name === "cancel_subagent") cancelled = true
    const data = { run_id: "r1", session_id: "child", status: "running" }
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
      structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }],
    } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const { port } = server.address() as { port: number }
    const { tools } = load(`http://127.0.0.1:${port}/api/mcp`)
    await assert.rejects(tools.get("run_subagent")!.execute("call", { prompt: "Review files" }, abort.signal), /abort/i)
    assert.equal(cancelled, true)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})
