import assert from "node:assert/strict"
import { test } from "node:test"
import { subagentCards, withSubagentCards, CARD_PATTERN } from "@/lib/subagents/cards"
import type { StoredMessage } from "@/lib/store/types"

test("subagent cards replace tool JSON only in the view and preserve message identity", () => {
  const tools = [
    { id: "a", name: "Agent", status: "done" as const, input: JSON.stringify({ description: "Review", prompt: "Check auth" }) },
    { id: "native:a", name: "agent_ui_native_subagent", status: "done" as const, output: JSON.stringify({ parentToolId: "a", text: "Looks good", tools: [{ id: "r", name: "Read", status: "done" }] }) },
    { id: "r", name: "Read", status: "done" as const, input: "auth.ts" },
  ]
  const message: StoredMessage = { id: "m", sender: "assistant", content: "Reviewed", tools, parts: tools.map((tool) => ({ type: "tool", id: tool.id, tool })) }
  const data = subagentCards([message], {})
  assert.equal(data.cards.size, 1)
  const view = withSubagentCards(message, data.cards, data.hidden)
  assert.equal(view.content, message.content)
  assert.equal(view.tools?.length, 0)
  assert.equal(message.tools?.length, 3)
  const part = view.parts!.at(-1)!
  assert.equal(part.type, "text")
  if (part.type === "text") assert.match(part.text, CARD_PATTERN)
  const again = subagentCards([message], {})
  assert.equal(withSubagentCards(message, again.cards, again.hidden), view)
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
  assert.equal(withSubagentCards(ordinary, new Map(), new Map()), ordinary)
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
