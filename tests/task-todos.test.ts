import assert from "node:assert/strict"
import { test } from "node:test"
import { applyStreamEvent, seedAssistantMessage } from "@/lib/message-stream"
import { taskTodos } from "@/lib/task-todos"
import type { StoredMessage } from "@/lib/store/types"

const messages = (tools: StoredMessage["tools"]): StoredMessage[] => [{ id: "a", sender: "assistant", content: "", tools }]
test("incremental Claude tasks appear before the turn ends and retain updates", () => {
  const create = { id: "create", name: "TaskCreate", status: "done" as const, input: JSON.stringify({ subject: "Fix streaming" }), output: "Task #7 created successfully: Fix streaming" }
  assert.equal(taskTodos(messages([{ ...create, status: "running", output: undefined }]))?.[0].content, "Fix streaming")
  const update = { id: "update", name: "TaskUpdate", status: "running" as const, input: JSON.stringify({ taskId: "7", status: "in_progress" }) }
  assert.deepEqual(taskTodos(messages([create, update])), [{ id: "7", content: "Fix streaming", status: "in_progress" }])
  assert.equal(taskTodos(messages([create, { ...update, input: JSON.stringify({ taskId: "7", status: "completed" }) }]))?.[0].status, "completed")
  assert.deepEqual(taskTodos(messages([create, { ...update, input: JSON.stringify({ taskId: "7", status: "deleted" }) }])), [])
  assert.equal(taskTodos(messages([{ ...create, status: "error" }])), null)
})


test("Claude file_path reaches the live file-card contract and survives completion", () => {
  const started = applyStreamEvent(seedAssistantMessage("turn"), { type: "tool", id: "edit", name: "Edit", status: "running", input: JSON.stringify({ file_path: "src/app.ts", old_string: "old", new_string: "new" }) })
  const done = applyStreamEvent(started, { type: "tool", id: "edit", name: "Edit", status: "done" })
  const args = JSON.parse(done.tools![0].input!)
  assert.equal(args.path, "src/app.ts")
  assert.equal(args.file_path, "src/app.ts")
  assert.equal(args.new_string, "new")
})
