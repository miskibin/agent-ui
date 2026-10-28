import assert from "node:assert/strict"
import test from "node:test"

import {
  describeToolOnlyTurn,
  replayHistory,
} from "@/lib/conversation-replay"
import { withPromptContext } from "@/lib/providers/system-prefix"
import type { StoredMessage } from "@/lib/store/types"

const user = (content: string): StoredMessage => ({
  id: `u-${content}`,
  content,
  sender: "user",
  createdAt: 1,
})

const stoppedTurn: StoredMessage = {
  id: "a1",
  content: "",
  sender: "assistant",
  createdAt: 2,
  parts: [
    { type: "thinking", id: "t", text: "..." },
    {
      type: "tool",
      id: "c1",
      tool: { id: "c1", name: "PowerShell", status: "done", input: "Get-ChildItem -Recurse" },
    },
    {
      type: "tool",
      id: "c2",
      tool: { id: "c2", name: "PowerShell", status: "running", input: "du  -sh\n .ollama" },
    },
  ],
}

test("a stopped turn with only tool calls still appears in the replay", () => {
  const turns = replayHistory([user("find caches"), stoppedTurn, user("continue")], false)
  assert.equal(turns.length, 3)
  assert.equal(turns[0].content, "find caches")
  assert.equal(turns[1].role, "assistant")
  assert.match(turns[1].content, /cut short after 2 tool calls: PowerShell/)
  assert.match(turns[1].content, /had not finished: du -sh .ollama/)
})

test("an assistant turn with neither text nor tools is still skipped", () => {
  const empty: StoredMessage = { ...stoppedTurn, parts: [] }
  assert.equal(describeToolOnlyTurn(empty), undefined)
  const turns = replayHistory([user("hi"), empty, user("again")], false)
  assert.deepEqual(
    turns.map((t) => t.content),
    ["hi", "again"]
  )
})

test("a fresh harness session is briefed with the chat; a resumed one is not", () => {
  const history = [
    { role: "user" as const, content: "find caches" },
    { role: "assistant" as const, content: "On it." },
  ]
  const fresh = withPromptContext("continue", { history })
  assert.match(fresh, /<conversation-history>[\s\S]*User: find caches[\s\S]*Assistant: On it\./)
  assert.ok(fresh.endsWith("\n\ncontinue"))
  assert.equal(withPromptContext("continue", { history, sessionId: "abc" }), "continue")
  assert.equal(withPromptContext("continue", {}), "continue")
})
