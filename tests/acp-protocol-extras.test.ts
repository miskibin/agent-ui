import assert from "node:assert/strict"
import { test } from "node:test"

import {
  commandsFromUpdate,
  mapAcpUpdate,
  matchSessionMode,
  toolName,
  usageFromUpdate,
  withConversationReplay,
  type AcpToolCallState,
} from "@/lib/acp-protocol"

const update = (body: Record<string, unknown>) => ({ sessionId: "s", update: body })

test("a tool's name comes from its title's shape, else from its kind", () => {
  assert.equal(toolName("read_file", "other"), "read_file")
  assert.equal(toolName("bash: npm test", "execute"), "bash")
  assert.equal(toolName("Read README.md", "read"), "Read")
  assert.equal(toolName("`ls -la`", "execute"), "Bash")
  assert.equal(toolName("Something odd", "other"), "Something odd")
  assert.equal(toolName(undefined, undefined), "tool")
})

test("locations, diffs and sentence titles fill in the card's arguments", () => {
  const tools = new Map<string, AcpToolCallState>()
  const [edit] = mapAcpUpdate(
    update({
      sessionUpdate: "tool_call",
      toolCallId: "e1",
      title: "Edit src/a.ts",
      kind: "edit",
      status: "completed",
      locations: [{ path: "/mnt/c/repo/src/a.ts" }],
      content: [{ type: "diff", path: "/mnt/c/repo/src/a.ts", oldText: "a", newText: "b" }],
    }),
    tools,
    { toAppPath: (p) => p.replace("/mnt/c/", "C:/") }
  )
  assert.equal(edit?.type, "tool")
  if (edit?.type !== "tool") return
  assert.equal(edit.name, "Edit")
  assert.deepEqual(JSON.parse(edit.input ?? "{}"), {
    path: "C:/repo/src/a.ts",
    oldText: "a",
    newText: "b",
  })

  const [shell] = mapAcpUpdate(
    update({
      sessionUpdate: "tool_call",
      toolCallId: "x1",
      title: "`npm test`",
      kind: "execute",
      status: "in_progress",
    }),
    tools
  )
  assert.equal(shell?.type === "tool" && shell.name, "Bash")
  assert.deepEqual(JSON.parse((shell?.type === "tool" && shell.input) || "{}"), {
    command: "npm test",
  })
})

test("an embedded terminal shows its output", () => {
  const tools = new Map<string, AcpToolCallState>()
  const [event] = mapAcpUpdate(
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      title: "bash",
      status: "completed",
      content: [{ type: "terminal", terminalId: "term-1" }],
    }),
    tools,
    { terminalOutput: (id) => (id === "term-1" ? "ok\n" : undefined) }
  )
  assert.equal(event?.type === "tool" && event.output, "ok\n")
})

test("usage, commands and modes are read off their updates", () => {
  assert.deepEqual(
    usageFromUpdate(
      update({ sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.02, currency: "USD" } })
    ),
    { used: 1200, size: 200000, costUsd: 0.02 }
  )
  assert.equal(usageFromUpdate(update({ sessionUpdate: "plan" })), null)
  assert.deepEqual(
    commandsFromUpdate(
      update({
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "/review", description: "Review changes", input: { hint: "branch" } },
          { name: "review" },
          { name: "" },
        ],
      })
    ),
    [{ name: "review", description: "Review changes", hint: "branch" }]
  )
  const modes = [{ id: "default" }, { id: "acceptEdits" }, { id: "plan" }, { id: "bypassPermissions" }]
  assert.equal(matchSessionMode("plan", modes), "plan")
  assert.equal(matchSessionMode("edits", modes), "acceptEdits")
  assert.equal(matchSessionMode("full", modes), undefined)
  assert.equal(matchSessionMode("read-only", [{ id: "ask" }, { id: "code" }]), "ask")
})

test("a fresh session is briefed with the conversation so far", () => {
  assert.equal(withConversationReplay("next", []), "next")
  const briefed = withConversationReplay("and now?", [
    { role: "user", content: "my name is Ada" },
    { role: "assistant", content: "Hi Ada" },
  ])
  assert.match(briefed, /<conversation-history>[\s\S]*User: my name is Ada[\s\S]*Assistant: Hi Ada[\s\S]*<\/conversation-history>\n\nand now\?$/)
})
