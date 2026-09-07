import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"

import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import { runPiAgent } from "@/lib/pi-agent"

/**
 * pi is stood in for by a script that replays a fixture of its `--mode json`
 * events: `resolvePiCommand` runs a `.js` `binPath` with the Node we are
 * already inside, so this drives the real spawn, the real framing and the real
 * teardown without the CLI.
 *
 * What is asserted is only what the loop around the translator does — a tool
 * row the stream never closed must not be left spinning when the process dies,
 * is stopped, or exits non-zero.
 */

const scratch = mkdtempSync(path.join(tmpdir(), "agent-ui-pi-"))
const fixturePath = path.join(scratch, "fixture.jsonl")
const fakePi = path.join(scratch, "fake-pi.js")

writeFileSync(
  fakePi,
  `const fs = require("node:fs")\n` +
    `fs.writeSync(1, fs.readFileSync(process.env.AGENT_UI_TEST_FIXTURE, "utf8"))\n` +
    `const hold = Number(process.env.AGENT_UI_TEST_HOLD_MS || "0")\n` +
    `const code = Number(process.env.AGENT_UI_TEST_EXIT || "0")\n` +
    `if (hold > 0) setTimeout(() => process.exit(code), hold)\n` +
    `else process.exit(code)\n`
)

process.env.AGENT_UI_TEST_FIXTURE = fixturePath

after(() => {
  delete process.env.AGENT_UI_TEST_FIXTURE
  delete process.env.AGENT_UI_TEST_HOLD_MS
  delete process.env.AGENT_UI_TEST_EXIT
  rmSync(scratch, { recursive: true, force: true })
})

function stage(
  lines: Record<string, unknown>[],
  options: { exit?: number; holdMs?: number } = {}
) {
  writeFileSync(
    fixturePath,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n"
  )
  process.env.AGENT_UI_TEST_EXIT = String(options.exit ?? 0)
  process.env.AGENT_UI_TEST_HOLD_MS = String(options.holdMs ?? 0)
}

function run(signal?: AbortSignal) {
  return runPiAgent({
    prompt: "hi",
    model: "ollama/qwen3:8b",
    workspace: scratch,
    configDir: scratch,
    sessionDir: scratch,
    binPath: fakePi,
    ...(signal ? { signal } : {}),
  })
}

async function collect(signal?: AbortSignal) {
  const events: AgentStreamEvent[] = []
  for await (const event of run(signal)) events.push(event)
  return events
}

const startBash = {
  type: "tool_execution_start",
  toolCallId: "t1",
  toolName: "bash",
  args: { command: "npm run dev" },
}

test("a tool pi never finished is closed when the process exits non-zero", async () => {
  stage(
    [{ type: "session", id: "pi-1" }, startBash],
    { exit: 2 }
  )

  const events = await collect()
  assert.deepEqual(events[0], { type: "session", sessionId: "pi-1" })
  const rows = events.filter((event) => event.type === "tool")
  assert.equal(rows.length, 2)
  assert.equal(rows[0].type === "tool" && rows[0].status, "running")
  assert.deepEqual(rows[1], {
    type: "tool",
    id: "t1",
    name: "bash",
    status: "error",
    output: "Interrupted",
  })
  assert.equal(events.at(-1)?.type, "error", "and the exit is still reported")
})

test("a tool that completed is left alone and the turn still finishes", async () => {
  stage([
    { type: "session", id: "pi-1" },
    startBash,
    {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }], exitCode: 0 },
    },
    { type: "message_end", message: { role: "assistant", usage: { input: 10, output: 4 } } },
  ])

  const events = await collect()
  const rows = events.filter((event) => event.type === "tool")
  assert.equal(rows.length, 2)
  assert.equal(rows[1].type === "tool" && rows[1].status, "done")
  assert.equal(rows[1].type === "tool" && rows[1].exitCode, 0)
  const done = events.at(-1)
  assert.equal(done?.type, "done")
  assert.deepEqual(done?.type === "done" && done.usage, { input: 10, output: 4 })
})

test("stopping the turn closes the rows pi left open", async () => {
  stage([{ type: "session", id: "pi-1" }, startBash], { holdMs: 30_000 })

  const controller = new AbortController()
  const events: AgentStreamEvent[] = []
  for await (const event of run(controller.signal)) {
    events.push(event)
    if (event.type === "tool" && event.status === "running") controller.abort()
  }

  assert.deepEqual(events.at(-1), {
    type: "tool",
    id: "t1",
    name: "bash",
    status: "error",
    output: "Interrupted",
  })
})

test("a pi that never starts reports the spawn failure, not a bare errno", async () => {
  const events: AgentStreamEvent[] = []
  for await (const event of runPiAgent({
    prompt: "hi",
    model: "ollama/qwen3:8b",
    workspace: scratch,
    configDir: scratch,
    sessionDir: scratch,
    binPath: path.join(scratch, "no-such-pi"),
  })) {
    events.push(event)
  }
  assert.equal(events.length, 1)
  assert.equal(events[0].type, "error")
  assert.ok(events[0].type === "error" && /pi not found/.test(events[0].message))
})
