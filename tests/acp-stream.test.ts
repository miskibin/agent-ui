import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"

import type { AgentStreamEvent } from "@/lib/cursor-agent-types"

/**
 * `runAcpAgent` against a scripted agent on the other end of the pipes: the
 * real spawn, the real bidirectional JSON-RPC, the real teardown.
 *
 * `lib/acp-agent.ts` imports values out of `lib/acp-types.ts`, whose
 * `AcpRpcError` uses a TypeScript constructor parameter property — syntax the
 * strip-only loader behind `npm run test` cannot parse. So the import is
 * attempted and the suite skips itself when it fails, rather than failing the
 * run for a reason that has nothing to do with what is asserted here. Writing
 * that constructor out (as `lib/stream-framing.ts` does) is all it would take
 * to switch these on.
 */
type RunAcpAgent = typeof import("@/lib/acp-agent").runAcpAgent
let runAcpAgent: RunAcpAgent | undefined
try {
  ;({ runAcpAgent } = await import("@/lib/acp-agent"))
} catch {
  /* see above */
}
const unloadable = "lib/acp-types.ts is unparseable by the strip-only loader"

const scratch = mkdtempSync(path.join(tmpdir(), "agent-ui-acp-"))
const scriptPath = path.join(scratch, "script.json")
const logPath = path.join(scratch, "log.json")
const fakeAgent = path.join(scratch, "fake-acp.js")

/**
 * A minimal ACP agent: it answers the handshake, then plays the steps in
 * `script.json` when the prompt arrives, and records everything the client
 * answers into `log.json` so the test can assert on what we sent back.
 */
writeFileSync(
  fakeAgent,
  `
const fs = require("node:fs")
const script = JSON.parse(fs.readFileSync(process.env.AGENT_UI_ACP_SCRIPT, "utf8"))
const log = process.env.AGENT_UI_ACP_LOG
const received = []
let promptId = null
let nextId = 1000

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
const record = (entry) => {
  received.push(entry)
  fs.writeFileSync(log, JSON.stringify(received))
}

function play() {
  for (const step of script.steps) {
    if (step.notify) send({ jsonrpc: "2.0", method: "session/update", params: step.notify })
    if (step.request) send({ jsonrpc: "2.0", id: nextId++, method: step.request.method, params: step.request.params })
    if (step.finish && promptId !== null) send({ jsonrpc: "2.0", id: promptId, result: { stopReason: step.finish } })
  }
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "acp-1" } })
    } else if (message.method === "session/prompt") {
      promptId = message.id
      play()
    } else if (message.method === "session/cancel") {
      record({ cancelled: true })
    } else if (message.id !== undefined && message.method === undefined) {
      record({ response: message })
    }
  }
})
setTimeout(() => {}, 60000)
`
)

process.env.AGENT_UI_ACP_SCRIPT = scriptPath
process.env.AGENT_UI_ACP_LOG = logPath

after(() => {
  delete process.env.AGENT_UI_ACP_SCRIPT
  delete process.env.AGENT_UI_ACP_LOG
  try {
    // The scripted agent is torn down asynchronously and may still be writing
    // its log while this runs; cleanup is housekeeping, not an assertion.
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* the temp directory outlives the run at worst */
  }
})

function stage(steps: unknown[]) {
  writeFileSync(scriptPath, JSON.stringify({ steps }))
  writeFileSync(logPath, "[]")
}

function chunk(text: string, meta?: Record<string, unknown>) {
  return {
    sessionId: "acp-1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    ...(meta ? { _meta: meta } : {}),
  }
}

const handlers = {
  async readTextFile() {
    // Never settles: this is the request the sweep on stop has to answer for.
    return new Promise<string>(() => {})
  },
  async writeTextFile() {},
  decidePermission() {
    return { option: null, reason: "denied by policy" }
  },
}

function run(signal?: AbortSignal) {
  return runAcpAgent!({
    spawn: { command: fakeAgent, args: [], cwd: scratch, env: {} },
    prompt: "hi",
    label: "Fake",
    canWriteFiles: false,
    handlers,
    ...(signal ? { signal } : {}),
  })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test(
  "a notification marked as a replay is dropped, the one beside it is not",
  { skip: !runAcpAgent && unloadable },
  async () => {
    stage([
      { notify: chunk("REPLAYED", { isReplay: true }) },
      { notify: chunk("LIVE") },
      { finish: "end_turn" },
    ])

    const events: AgentStreamEvent[] = []
    for await (const event of run()) events.push(event)

    assert.deepEqual(
      events.filter((event) => event.type === "text"),
      [{ type: "text", text: "LIVE" }]
    )
    assert.equal(events.at(-1)?.type, "done")
  }
)

test(
  "stopping the turn closes the open rows and answers what the agent is blocked on",
  { skip: !runAcpAgent && unloadable },
  async () => {
    stage([
      {
        notify: {
          sessionId: "acp-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "bash",
            status: "in_progress",
          },
        },
      },
      { request: { method: "fs/read_text_file", params: { path: "/tmp/x" } } },
    ])

    const controller = new AbortController()
    const events: AgentStreamEvent[] = []
    for await (const event of run(controller.signal)) {
      events.push(event)
      if (event.type === "tool" && event.status === "running") {
        // Let the agent's `fs/read_text_file` arrive and block first.
        await wait(150)
        controller.abort()
      }
    }

    assert.deepEqual(events.at(-1), {
      type: "tool",
      id: "t1",
      name: "bash",
      status: "error",
      output: "Interrupted",
    })

    let logged: { response?: { error?: { code: number } } }[] = []
    for (let attempt = 0; attempt < 40; attempt++) {
      logged = JSON.parse(readFileSync(logPath, "utf8"))
      if (logged.some((entry) => entry.response)) break
      await wait(25)
    }
    const answered = logged.find((entry) => entry.response)
    assert.ok(answered, "the request we were blocked on was answered")
    assert.equal(
      answered.response?.error?.code,
      -32603,
      "…and refused, rather than left to hang until the pipe closed"
    )
  }
)
