import assert from "node:assert/strict"
import { test } from "node:test"

import {
  sandboxFor,
  translateCodexNotification,
  usageFromNotification,
} from "@/lib/codex-protocol"
import { handleCodexApproval } from "@/lib/providers/codex"
import { completedAgentMessageText } from "@/lib/providers/codex"
import type { AgentRunOptions } from "@/lib/providers/types"

test("maps permission modes to Codex sandbox modes", () => {
  assert.equal(sandboxFor("read-only"), "read-only")
  assert.equal(sandboxFor("edits"), "workspace-write")
  assert.equal(sandboxFor("full"), "danger-full-access")
})

test("uses completed agent text only when no deltas were streamed", () => {
  const completed = {
    method: "item/completed",
    params: { item: { type: "agentMessage", id: "a1", text: "complete" } },
  }
  assert.equal(completedAgentMessageText(completed, new Set()), "complete")
  assert.equal(completedAgentMessageText(completed, new Set(["a1"])), undefined)
})

test("translates streamed text, reasoning, commands, and file changes", () => {
  assert.deepEqual(translateCodexNotification({ method: "item/agentMessage/delta", params: { delta: "hello" } }), [{ type: "text", text: "hello" }])
  assert.deepEqual(translateCodexNotification({ method: "item/reasoning/summaryTextDelta", params: { delta: "think" } }), [{ type: "thinking", text: "think" }])
  assert.deepEqual(translateCodexNotification({ method: "item/completed", params: { item: { type: "commandExecution", id: "c1", command: "npm test", cwd: "C:/repo", status: "completed", aggregatedOutput: "ok", exitCode: 0 } } }), [{ type: "tool", id: "c1", name: "Shell", status: "done", input: JSON.stringify({ command: "npm test", cwd: "C:/repo" }), output: "ok", exitCode: 0 }])
  assert.deepEqual(translateCodexNotification({ method: "item/started", params: { item: { type: "fileChange", id: "f1", changes: [{ path: "a.ts", diff: "@@" }] } } }), [{ type: "tool", id: "f1:0", name: "ApplyPatch", status: "running", input: JSON.stringify({ path: "a.ts", diff: "@@" }) }])
})

test("reports failure and per-turn token usage", () => {
  assert.deepEqual(translateCodexNotification({ method: "turn/completed", params: { turn: { status: "failed", error: { message: "bad model" } } } }), [{ type: "error", message: "bad model" }])
  assert.deepEqual(translateCodexNotification({ method: "turn/completed", params: { turn: { status: "interrupted" } } }), [{ type: "error", message: "Codex turn interrupted" }])
  assert.deepEqual(usageFromNotification({ method: "thread/tokenUsage/updated", params: { tokenUsage: { modelContextWindow: 200000, last: { inputTokens: 12, outputTokens: 7, cachedInputTokens: 3, cacheWriteInputTokens: 2, reasoningOutputTokens: 4 } } } }), { input: 12, output: 7, cachedInputTokens: 3, cacheCreationTokens: 2, reasoningTokens: 4, contextWindow: 200000 })
})

test("approval requests wait for the user and answer the app-server", async () => {
  const responses: unknown[] = []
  const options = {
    prompt: "",
    model: "model",
    signal: new AbortController().signal,
    askUser: async () => ({ optionId: "accept" }),
  } as AgentRunOptions
  const events = []
  for await (const event of handleCodexApproval(
    { id: 9, method: "item/commandExecution/requestApproval", params: { itemId: "cmd", command: "npm test", availableDecisions: ["accept", "decline"] } },
    options,
    { respond: (id, result) => { responses.push({ id, result }) } }
  )) events.push(event)
  assert.equal(events[0]?.type, "tool")
  assert.deepEqual(responses, [{ id: 9, result: { decision: "accept" } }])
  assert.equal(events.at(-1)?.type, "tool")
})

test("approval requests decline safely without an interactive channel", async () => {
  const responses: unknown[] = []
  const options = { prompt: "", model: "model", signal: new AbortController().signal } as AgentRunOptions
  for await (const event of handleCodexApproval(
    { id: 10, method: "item/fileChange/requestApproval", params: { itemId: "patch" } },
    options,
    { respond: (id, result) => { responses.push({ id, result }) } }
  )) { void event }
  assert.deepEqual(responses, [{ id: 10, result: { decision: "cancel" } }])
})
