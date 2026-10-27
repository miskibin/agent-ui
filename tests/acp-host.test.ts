import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"

import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import { closeAcpHosts, runAcpAgent, type AcpRunOptions } from "@/lib/acp-agent"

/**
 * The agent process outliving the turn — the thing that makes an agent with
 * no `session/load` remember the previous message. The fake below behaves
 * the way tinyagent's `--acp` mode does: sessions live in its memory only, it
 * streams text and a `usage_update`, and a second prompt in the same session
 * continues the conversation.
 */

const scratch = mkdtempSync(path.join(tmpdir(), "agent-ui-acp-host-"))
const fakeAgent = path.join(scratch, "tiny-acp.js")

writeFileSync(
  fakeAgent,
  `
const sessions = new Map()
let nextSession = 0
let nextId = 5000
const waiting = new Map()
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
const call = (method, params) => new Promise((resolve) => {
  const id = nextId++
  waiting.set(id, resolve)
  send({ jsonrpc: "2.0", id, method, params })
})
const update = (sessionId, body) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } })

async function prompt(message) {
  const { sessionId, prompt } = message.params
  const session = sessions.get(sessionId)
  if (!session) return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "unknown sessionId" } })
  const text = prompt.map((block) => block.text ?? "").join("")
  session.turns.push(text)
  if (text.includes("RUN")) {
    const created = await call("terminal/create", { sessionId, command: "echo terminal-ok" })
    await call("terminal/wait_for_exit", { sessionId, terminalId: created.terminalId })
    const out = await call("terminal/output", { sessionId, terminalId: created.terminalId })
    await call("terminal/release", { sessionId, terminalId: created.terminalId })
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ran:" + out.output.trim() } })
  }
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "pid=" + process.pid + " turn=" + session.turns.length + " saw=" + JSON.stringify(text) },
  })
  update(sessionId, { sessionUpdate: "usage_update", used: 321, size: 128000 })
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
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
    const message = JSON.parse(line)
    if (message.id !== undefined && message.method === undefined) {
      const resolve = waiting.get(message.id)
      waiting.delete(message.id)
      resolve?.(message.result ?? {})
      continue
    }
    switch (message.method) {
      case "initialize":
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: true } } } })
        break
      case "session/new": {
        const sessionId = "sess_" + ++nextSession
        sessions.set(sessionId, { turns: [] })
        send({ jsonrpc: "2.0", id: message.id, result: { sessionId } })
        break
      }
      case "session/prompt":
        void prompt(message)
        break
      default:
        if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found: " + message.method } })
    }
  }
})
process.stdin.on("end", () => process.exit(0))
`
)

after(async () => {
  await closeAcpHosts()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const handlers = {
  async readTextFile() {
    return ""
  },
  async writeTextFile() {},
  decidePermission() {
    return { option: null, reason: "denied" }
  },
}

async function turn(
  prompt: string,
  extra: Partial<AcpRunOptions> = {}
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const event of runAcpAgent({
    spawn: { command: fakeAgent, args: [], cwd: scratch, env: {} },
    prompt,
    label: "Tiny",
    canWriteFiles: true,
    keepAlive: true,
    handlers,
    ...extra,
  })) {
    events.push(event)
  }
  return events
}

const text = (events: AgentStreamEvent[]) =>
  events.map((event) => (event.type === "text" ? event.text : "")).join("")
const sessionOf = (events: AgentStreamEvent[]) =>
  events.find((event): event is Extract<AgentStreamEvent, { type: "session" }> => event.type === "session")
    ?.sessionId

test("the second turn runs in the same process and the same session", async () => {
  const first = await turn("hello")
  const sessionId = sessionOf(first)
  assert.ok(sessionId)
  const pid = /pid=(\d+)/.exec(text(first))?.[1]
  assert.match(text(first), /turn=1/)

  const second = await turn("again", { sessionId, history: [{ role: "user", content: "hello" }] })
  assert.equal(sessionOf(second), sessionId)
  assert.equal(/pid=(\d+)/.exec(text(second))?.[1], pid)
  assert.match(text(second), /turn=2 saw="again"/)

  const done = second.at(-1)
  assert.equal(done?.type, "done")
  assert.deepEqual(done?.type === "done" ? done.usage : undefined, { input: 321, contextWindow: 128000 })
})

test("a session the process no longer has is replaced, and briefed", async () => {
  await closeAcpHosts()
  const events = await turn("what is my name?", {
    sessionId: "sess_gone",
    history: [
      { role: "user", content: "my name is Ada" },
      { role: "assistant", content: "Hi Ada" },
    ],
  })
  assert.notEqual(sessionOf(events), "sess_gone")
  assert.match(text(events), /turn=1/)
  assert.match(text(events), /conversation-history/)
  assert.match(text(events), /my name is Ada/)
})

test("an agent can run a command through the client's terminal", async () => {
  const events = await turn("RUN it", { terminalRoot: scratch })
  assert.match(text(events), /ran:terminal-ok/)
})
