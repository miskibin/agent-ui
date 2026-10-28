import assert from "node:assert/strict"
import { test } from "node:test"
import { ClaudeCodeTranslator, type ClaudeCodeCliEvent } from "@/lib/claude-code-protocol"
import { applyStreamEvent, seedAssistantMessage } from "@/lib/message-stream"
import { nativeAgents, withoutNativeActivity } from "@/lib/subagents/native"

test("native agents retain independent transcripts, deduplicate snapshots, and settle with their parent tool", () => {
  const translator = new ClaudeCodeTranslator()
  let message = seedAssistantMessage("turn")
  const absorb = (event: ClaudeCodeCliEvent) => {
    for (const frame of translator.translate(event)) message = applyStreamEvent(message, frame)
  }
  absorb({ type: "assistant", message: { content: [{ type: "tool_use", id: "agent-a", name: "Agent", input: { description: "Inspect auth", prompt: "Review login" } }] } })
  for (const id of ["agent-a", "agent-b"]) {
    absorb({ type: "stream_event", parent_tool_use_id: id, event: { type: "message_start", message: { id } } })
    absorb({ type: "stream_event", parent_tool_use_id: id, event: { type: "content_block_delta", delta: { type: "text_delta", text: `Result ${id}` } } })
    absorb({ type: "assistant", parent_tool_use_id: id, message: { id, model: "reported-model", content: [{ type: "text", text: `Result ${id}` }] } })
  }
  absorb({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent-a", content: "Done" }] } })
  for (const frame of translator.finish(false)) message = applyStreamEvent(message, frame)
  const agents = nativeAgents(JSON.parse(JSON.stringify([message])))
  assert.equal(message.content, "")
  assert.equal(agents.length, 2)
  assert.equal(agents[0].text, "Result agent-a")
  assert.equal(agents[0].title, "Inspect auth")
  assert.equal(agents[0].prompt, "Review login")
  assert.equal(agents[0].model, "reported-model")
  assert.equal(agents[0].status, "done")
  assert.equal(agents[1].text, "Result agent-b")
  assert.equal(agents[1].status, "error")
  assert.equal(withoutNativeActivity(message).tools?.length, 1)
  assert.deepEqual(translator.finish(false), [])
})

test("a native agent without streamed activity still exposes its final result", () => {
  const translator = new ClaudeCodeTranslator()
  let message = seedAssistantMessage("turn")
  const events: ClaudeCodeCliEvent[] = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Task", input: { description: "Review" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "No issues found" }] } },
  ]
  for (const event of events) for (const frame of translator.translate(event)) message = applyStreamEvent(message, frame)
  assert.equal(nativeAgents([message])[0].text, "No issues found")
  assert.equal(nativeAgents([message])[0].status, "done")
})


test("a native agent is visible as soon as its tool starts streaming", () => {
  const translator = new ClaudeCodeTranslator()
  let message = seedAssistantMessage("turn")
  for (const event of translator.translate({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "early", name: "Agent" } } })) {
    message = applyStreamEvent(message, event)
  }
  assert.equal(nativeAgents([message])[0].status, "running")
  assert.equal(nativeAgents([message])[0].parentToolId, "early")
})
