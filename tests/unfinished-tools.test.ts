import assert from "node:assert/strict"
import { test } from "node:test"

import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import { UnfinishedTools, UNFINISHED_TOOL_OUTPUT } from "@/lib/unfinished-tools"

const running = (id: string, name: string): AgentStreamEvent => ({
  type: "tool",
  id,
  name,
  status: "running",
})

test("a row that completed is not closed out again", () => {
  const open = new UnfinishedTools()
  open.track(running("t1", "bash"))
  open.track({ type: "tool", id: "t1", name: "bash", status: "done", output: "ok" })
  assert.equal(open.size, 0)
  assert.deepEqual([...open.finish()], [])
})

test("a row that failed also closes the entry", () => {
  const open = new UnfinishedTools()
  open.track(running("t1", "bash"))
  open.track({ type: "tool", id: "t1", name: "bash", status: "error" })
  assert.deepEqual([...open.finish()], [])
})

test("every row still running gets one terminal event, once", () => {
  const open = new UnfinishedTools()
  open.track(running("t1", "bash"))
  open.track(running("t2", "read"))
  open.track({ type: "text", text: "…" })
  open.track({ type: "done" })
  assert.equal(open.size, 2)

  assert.deepEqual(
    [...open.finish()],
    [
      { type: "tool", id: "t1", name: "bash", status: "error", output: UNFINISHED_TOOL_OUTPUT },
      { type: "tool", id: "t2", name: "read", status: "error", output: UNFINISHED_TOOL_OUTPUT },
    ]
  )
  // Draining empties it: a second abnormal exit path must not re-emit.
  assert.deepEqual([...open.finish()], [])
})

test("a later update to the same id refines the one row", () => {
  const open = new UnfinishedTools()
  open.track(running("t1", "sh"))
  open.track(running("t1", "bash"))
  const closed = [...open.finish()]
  assert.equal(closed.length, 1)
  assert.equal(closed[0].type === "tool" && closed[0].name, "bash")
})
