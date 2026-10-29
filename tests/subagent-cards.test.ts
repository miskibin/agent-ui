import assert from "node:assert/strict"
import { test } from "node:test"
import { subagentCards, withoutSubagentSnapshots, activeSubagentCards } from "@/lib/subagents/cards"
import type { StoredMessage } from "@/lib/store/types"

test("subagent snapshots stay out of the view while real tool history and answer stay intact", () => {
  const tools = [
    { id: "a", name: "Agent", status: "done" as const, input: JSON.stringify({ description: "Review", prompt: "Check auth" }) },
    { id: "native:a", name: "agent_ui_native_subagent", status: "done" as const, output: JSON.stringify({ parentToolId: "a", text: "Looks good", tools: [{ id: "r", name: "Read", status: "done" }] }) },
    { id: "r", name: "Read", status: "done" as const, input: "auth.ts" },
  ]
  const message: StoredMessage = { id: "m", sender: "assistant", content: "Reviewed", tools, parts: tools.map((tool) => ({ type: "tool", id: tool.id, tool })) }
  const data = subagentCards([message], {})
  assert.equal(data.cards.size, 1)
  const view = withoutSubagentSnapshots(message)
  assert.equal(view.content, message.content)
  assert.equal(view.tools?.length, 2)
  assert.equal(message.tools?.length, 3)
  assert.deepEqual(view.parts?.map((part) => part.type === "tool" && part.tool.id), ["a", "r"])
  assert.equal(withoutSubagentSnapshots(message), view)

})

test("MCP-wrapped delegation receipts retain the child chat id and actual outcome", () => {
  const message: StoredMessage = { id: "m", sender: "assistant", content: "", tools: [{
    id: "delegate", name: "mcp__agent-ui__run_subagent", status: "done",
    input: JSON.stringify({ title: "Implement", harness: "pi" }),
    output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ session_id: "child", status: "cancelled", answer: "Stopped" }) }] }),
  }] }
  const card = [...subagentCards([message], {}).cards.values()][0]
  assert.equal(card.sessionId, "child")
  assert.equal(card.status, "cancelled")
  assert.equal(card.text, "Stopped")
  assert.equal(card.harness, "pi")
  const ordinary: StoredMessage = { id: "ordinary", sender: "assistant", content: "Hello" }
  assert.equal(withoutSubagentSnapshots(ordinary), ordinary)
})

test("pi shell delegation is visible and tracks the live run, not the launch receipt", () => {
  const receipt = { run_id: "r1", session_id: "child", status: "running", title: "Subagent test", harness: "ollama", model: "qwen" }
  const message: StoredMessage = { id: "m", sender: "assistant", content: "Launching", tools: [{
    id: "shell", name: "bash", status: "done",
    input: JSON.stringify({ command: 'node bin/agent-ui.mjs run ollama --background "test"' }),
    output: JSON.stringify(receipt),
  }] }
  const live = { runId: "r1", sessionId: "child", parentId: "parent", title: "Subagent test", harness: "ollama", model: "qwen", prompt: "test", status: "running" as const, startedAt: 1, userMessageId: "u", assistantMessageId: "a" }
  const running = subagentCards([message], { child: live })
  assert.equal([...running.cards.values()][0].status, "running")
  assert.equal(running.hidden.get("m")?.has("shell"), true)
  const done = subagentCards([message], { child: { ...live, status: "done" } })
  assert.equal([...done.cards.values()][0].status, "done")
  assert.equal([...done.cards.values()][0].sessionId, "child")
  assert.equal([...subagentCards([message], {}).cards.values()][0].status, "unknown")
  const ordinary = { ...message, tools: [{ ...message.tools![0], input: JSON.stringify({ command: "echo hello" }) }] }
  assert.equal(subagentCards([ordinary], {}).cards.size, 0)
})

test("Pi extension receipts link running cards to the right child and follow terminal status", () => {
  const receipt = { run_id: "r1", session_id: "child", status: "running", title: "Review" }
  const message: StoredMessage = { id: "m", sender: "assistant", content: "", tools: [{
    id: "delegate", name: "run_subagent", status: "running", input: JSON.stringify({ prompt: "Check files" }), output: JSON.stringify(receipt),
  }] }
  const run = { runId: "r1", sessionId: "child", parentId: "parent", title: "Review", harness: "pi", model: "ollama/nemotron", prompt: "Check files", status: "running" as const, startedAt: 1, userMessageId: "u", assistantMessageId: "a" }
  assert.equal([...subagentCards([message], { child: run }).cards.values()][0].status, "running")
  assert.equal([...subagentCards([message], { child: { ...run, status: "done" } }).cards.values()][0].status, "done")
  assert.equal([...subagentCards([message], { child: { ...run, status: "cancelled" } }).cards.values()][0].status, "cancelled")
  assert.equal(subagentCards([message], { child: run }).hidden.get("m")?.has("delegate"), true)
  const live = subagentCards([message], { child: run })
  assert.equal(withoutSubagentSnapshots(message), message)
  assert.deepEqual(activeSubagentCards(live.cards).map((card) => card.sessionId), ["child"])
  assert.equal(activeSubagentCards(subagentCards([message], { child: { ...run, status: "queued" } }).cards).length, 1)
  for (const status of ["done", "error", "cancelled"] as const) {
    const settled = subagentCards([message], { child: { ...run, status } })
    assert.equal(activeSubagentCards(settled.cards).length, 0)
  }
  assert.equal(message.tools?.length, 1)

})
