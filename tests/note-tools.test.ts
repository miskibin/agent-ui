import assert from "node:assert/strict"
import { test } from "node:test"

import { applyNoteOps, splitBlocks } from "@/lib/notes/blocks"
import { callNoteTool, parseNoteOps, type NoteTools } from "@/lib/notes/tools"
import { handleRpc, type SubagentTools } from "@/lib/subagents/mcp"

function memoryNote(initial: string) {
  let rev = 1
  let content = initial
  const history = new Map<number, string>([[1, initial]])
  const tools: NoteTools = {
    async read() {
      return { rev, title: "T", content }
    },
    async readAt(at) {
      return history.get(at)
    },
    async edit(ops) {
      const result = applyNoteOps(content, ops)
      if (result.ok && result.source !== content) {
        content = result.source
        rev++
        history.set(rev, content)
      }
      return { rev, result }
    },
  }
  return { tools, get content() { return content }, set content(next: string) { content = next; rev++; history.set(rev, next) } }
}

test("note_read returns blocks with ids, and since_rev only what changed", async () => {
  const note = memoryNote("# T\n\nOne.\n\nTwo.\n")
  const read = await callNoteTool(note.tools, "note_read", {})
  const data = read.data as { rev: number; blocks: { id: string; type: string }[] }
  assert.equal(data.rev, 1)
  assert.deepEqual(data.blocks.map((block) => block.type), ["h1", "paragraph", "paragraph"])
  note.content = "# T\n\nOne.\n\nTwo, changed.\n"
  const since = (await callNoteTool(note.tools, "note_read", { since_rev: 1 })).data as {
    blocks: { markdown: string }[]
    gone: string[]
    unchanged: number
  }
  assert.deepEqual(since.blocks.map((block) => block.markdown), ["Two, changed."])
  assert.equal(since.gone.length, 1)
  assert.equal(since.unchanged, 2)
})

test("note_edit applies ops and refuses a stale id with nothing written", async () => {
  const note = memoryNote("# T\n\nOne.\n")
  const [, paragraph] = splitBlocks(note.content)
  const ok = await callNoteTool(note.tools, "note_edit", {
    ops: [{ op: "pending", after: paragraph.id, intent: "diagram" }],
  })
  assert.ok(!ok.isError)
  assert.equal((ok.data as { pending: string[] }).pending.length, 1)
  note.content = "# T\n\nOne, edited.\n"
  const stale = await callNoteTool(note.tools, "note_edit", {
    ops: [{ op: "replace", id: paragraph.id, markdown: "Agent" }],
  })
  assert.equal(stale.isError, true)
  assert.match(String(stale.data), /Nothing was changed/)
  assert.equal(note.content, "# T\n\nOne, edited.\n")
})

test("op arguments are validated", () => {
  assert.equal(typeof parseNoteOps([]), "string")
  assert.equal(typeof parseNoteOps([{ op: "replace", id: "x" }]), "string")
  assert.deepEqual(parseNoteOps([{ op: "insert", after: "end", markdown: "x" }]), [
    { op: "insert", markdown: "x", after: "end" },
  ])
})

test("the bridge offers only the note tools in a note's turn", async () => {
  const note = memoryNote("Body\n")
  const tools = {} as SubagentTools
  const list = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, tools, "1", undefined, note.tools)
  const names = ((list as { result: { tools: { name: string }[] } }).result.tools).map((tool) => tool.name)
  assert.deepEqual(names, ["note_read", "note_edit"])
  const refused = await handleRpc(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_subagent", arguments: {} } },
    tools, "1", undefined, note.tools
  )
  assert.equal((refused as { result: { isError?: boolean } }).result.isError, true)
  const outside = await handleRpc(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "note_read", arguments: {} } },
    tools, "1"
  )
  assert.equal((outside as { result: { isError?: boolean } }).result.isError, true)
})
