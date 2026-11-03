import assert from "node:assert/strict"
import { test } from "node:test"

import {
  applyNoteOps,
  mergeNotes,
  noteTitle,
  PENDING_LANGUAGE,
  splitBlocks,
  stripPending,
} from "@/lib/notes/blocks"

const NOTE = `---
tags: [design]
---

# Login service
The client posts credentials.

- one
- two

- three
  continued

\`\`\`ts
const a = 1

const b = 2
\`\`\`

$$
x^2
$$

| a | b |
| - | - |
| 1 | 2 |

Last paragraph.
`

test("splits a note into the blocks a reader sees", () => {
  const blocks = splitBlocks(NOTE)
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["frontmatter", "heading", "paragraph", "list", "code", "math", "table", "paragraph"]
  )
  assert.equal(blocks[3].text, "- one\n- two\n\n- three\n  continued")
  assert.equal(blocks[4].detail, "ts")
  assert.ok(blocks[4].text.includes("const b = 2"))
  for (const block of blocks) assert.equal(NOTE.slice(block.start, block.end), block.text)
})

test("ids are content hashes that ignore markdown spelling", () => {
  const [a] = splitBlocks("- **bold** item\n- other")
  const [b] = splitBlocks("* __bold__ item\n* other")
  assert.equal(a.id, b.id)
  const [c] = splitBlocks("- **bold** item\n- changed")
  assert.notEqual(a.id, c.id)
  const [h2] = splitBlocks("## Title")
  const [h3] = splitBlocks("### Title")
  assert.notEqual(h2.id, h3.id)
})

test("duplicate blocks get distinct ids", () => {
  const blocks = splitBlocks("same\n\nsame\n")
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1].id, `${blocks[0].id}~2`)
})

test("title comes from the first heading", () => {
  assert.equal(noteTitle(NOTE), "Login service")
  assert.equal(noteTitle("plain text\n\n# Later"), "")
})

test("replace, insert and delete by id, all or nothing", () => {
  const blocks = splitBlocks(NOTE)
  const paragraph = blocks[2]
  const last = blocks[7]
  const result = applyNoteOps(NOTE, [
    { op: "replace", id: paragraph.id, markdown: "The client posts credentials to the gateway." },
    { op: "insert", after: splitBlocks("The client posts credentials to the gateway.")[0].id, markdown: "```mermaid\nflowchart LR\n  A-->B\n```" },
    { op: "delete", id: last.id },
  ])
  assert.ok(result.ok)
  if (!result.ok) return
  assert.ok(result.source.includes("to the gateway.\n\n```mermaid"))
  assert.ok(!result.source.includes("Last paragraph."))
  assert.equal(result.written[0].length, 1)
  assert.equal(splitBlocks(result.source).at(-1)?.type, "table")
})

test("an op on a block someone edited is refused and nothing is written", () => {
  const stale = splitBlocks(NOTE)[2].id
  const edited = NOTE.replace("The client posts credentials.", "The client posts credentials over TLS.")
  const result = applyNoteOps(edited, [
    { op: "insert", after: "end", markdown: "New" },
    { op: "replace", id: stale, markdown: "Agent version" },
  ])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.index, 1)
  assert.equal(result.error.code, "block_changed")
})

test("pending placeholders are planted, filled and stripped", () => {
  const result = applyNoteOps("# T\n\nBody\n", [{ op: "pending", after: "end", intent: "A diagram of the flow" }])
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.pending.length, 1)
  assert.ok(result.source.includes(`\`\`\`${PENDING_LANGUAGE}\nA diagram of the flow\n\`\`\``))
  const filled = applyNoteOps(result.source, [{ op: "replace", id: result.pending[0], markdown: "Done." }])
  assert.ok(filled.ok)
  if (filled.ok) assert.equal(filled.source, "# T\n\nBody\n\nDone.\n")
  assert.equal(stripPending(result.source), "# T\n\nBody\n")
})

test("replace_text needs a unique quote", () => {
  const ok = applyNoteOps("alpha beta\n\ngamma\n", [{ op: "replace_text", find: "beta", with: "BETA" }])
  assert.ok(ok.ok && ok.source === "alpha BETA\n\ngamma\n")
  const twice = applyNoteOps("x y\n\nx z\n", [{ op: "replace_text", find: "x", with: "w" }])
  assert.ok(!twice.ok && twice.error.code === "ambiguous")
})

test("insert at start keeps front matter first", () => {
  const result = applyNoteOps("---\na: 1\n---\n\nBody\n", [{ op: "insert", after: "start", markdown: "# Title" }])
  assert.ok(result.ok)
  if (result.ok) assert.equal(result.source, "---\na: 1\n---\n\n# Title\n\nBody\n")
})

test("merge keeps both sides' changes to different blocks", () => {
  const base = "# T\n\nOne.\n\nTwo.\n\nThree.\n"
  const ours = "# T\n\nOne, edited by the user.\n\nTwo.\n\nThree.\n"
  const theirs = "# T\n\nOne.\n\nTwo.\n\n```mermaid\ngraph TD\n```\n\nThree.\n"
  assert.equal(
    mergeNotes(base, ours, theirs),
    "# T\n\nOne, edited by the user.\n\nTwo.\n\n```mermaid\ngraph TD\n```\n\nThree.\n"
  )
})

test("merge of a conflict keeps both versions rather than losing one", () => {
  const base = "A\n\nB\n"
  const merged = mergeNotes(base, "A\n\nB by user\n", "A\n\nB by agent\n")
  assert.equal(merged, "A\n\nB by user\n\nB by agent\n")
})

test("merge with one side unchanged is that side", () => {
  assert.equal(mergeNotes("a\n", "a\n", "b\n"), "b\n")
  assert.equal(mergeNotes("a\n", "c\n", "a\n"), "c\n")
})

test("merge keeps an insertion next to a block the other side retyped", () => {
  const base = "# T\n\nPara.\n\nEnd.\n"
  const ours = "# T\n\nPara, retyped.\n\nEnd.\n"
  const theirs = "# T\n\nPara.\n\n```mermaid\ngraph TD\n```\n\nEnd.\n"
  assert.equal(mergeNotes(base, ours, theirs), "# T\n\nPara, retyped.\n\n```mermaid\ngraph TD\n```\n\nEnd.\n")
  // And the other way round: the person inserted, the agent retyped.
  assert.equal(mergeNotes(base, theirs, ours), "# T\n\nPara, retyped.\n\n```mermaid\ngraph TD\n```\n\nEnd.\n")
})
