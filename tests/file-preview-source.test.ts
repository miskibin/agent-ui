import assert from "node:assert/strict"
import { test } from "node:test"

import {
  isPartialBody,
  mergeDiskRead,
  needsDiskRead,
  noticeFromDiskRead,
  type PreviewBody,
} from "@/lib/file-preview-source"

/** What the panel hands the merge: the vendored preview, narrowed to what it reads. */
type Preview = PreviewBody & { path: string }

/**
 * The rule the file panel lives by: a read tool's output is a *window* on a
 * file, never the file, and the panel has to go to disk for the rest.
 *
 * This is the regression the module exists for. `filePreviewFromTool` seeds
 * `content` from a read tool's output, and the panel used to take any content
 * at all as reason to skip the disk read — so `Read(file, limit: 40)` left the
 * File view showing forty lines of a three-thousand-line file, with nothing
 * saying so.
 */

test("a read tool's window is a placeholder, not the file", () => {
  const window = { content: "line 1\nline 2", startLine: 1 }
  assert.equal(isPartialBody(window), true)
  assert.equal(needsDiskRead(window), true)
})

test("an offset read is a window too, wherever it starts", () => {
  assert.equal(needsDiskRead({ content: "…", startLine: 500 }), true)
})

test("a mutation tool's after-file stands — the diff beside it describes it", () => {
  const afterFile = { content: "the whole file the tool wrote\n" }
  assert.equal(isPartialBody(afterFile), false)
  assert.equal(needsDiskRead(afterFile), false)
})

test("a preview with no body at all is read from disk", () => {
  assert.equal(needsDiskRead({}), true)
})

test("an image is never read as text", () => {
  assert.equal(needsDiskRead({ imageSrc: "/api/files?path=a.png" }), false)
  // Even one that somehow carries both: the picture wins.
  assert.equal(
    needsDiskRead({ imageSrc: "/api/files?path=a.png", content: "x", startLine: 1 }),
    false
  )
})

test("an empty body is still a body — a genuinely empty file is not re-read", () => {
  assert.equal(needsDiskRead({ content: "" }), false)
})

test("disk text replaces the window, and startLine does not survive it", () => {
  const merged = mergeDiskRead(
    { path: "app/page.tsx", content: "40 lines worth", startLine: 1 },
    "app/page.tsx",
    { content: "the whole file" }
  )
  assert.equal(merged.content, "the whole file")
  assert.ok(
    !("startLine" in merged),
    "a whole-file body must not keep a start line, or every row renumbers"
  )
})

test("where the agent was reading becomes where the panel opens", () => {
  const open: Preview = { path: "lib/store.ts", content: "…", startLine: 500 }
  const merged = mergeDiskRead(open, "lib/store.ts", { content: "whole" })
  assert.equal(merged.focusLine, 500)
})

test("a line the caller asked for outranks the read's offset", () => {
  const open: Preview = {
    path: "lib/store.ts",
    content: "…",
    startLine: 500,
    focusLine: 42,
  }
  const merged = mergeDiskRead(open, "lib/store.ts", { content: "whole" })
  assert.equal(merged.focusLine, 42)
})

test("a read starting at line 1 asks for no focus", () => {
  const merged = mergeDiskRead(
    { path: "a.ts", content: "…", startLine: 1 },
    "a.ts",
    { content: "whole" }
  )
  assert.ok(!("focusLine" in merged), "line 1 is where the panel already opens")
})

test("the route's repaired path travels back to the header", () => {
  const merged = mergeDiskRead({ path: "Messages.tsx" }, "Messages.tsx", {
    path: "src/components/Messages.tsx",
    content: "whole",
  })
  assert.equal(merged.path, "src/components/Messages.tsx")
})

test("a read for another file cannot rewrite the one on screen", () => {
  const open = { path: "b.ts", content: "b" }
  assert.deepEqual(mergeDiskRead(open, "a.ts", { content: "a" }), open)
})

test("only a truncated read owes the reader a banner", () => {
  assert.equal(noticeFromDiskRead({ content: "x" }), null)
  assert.deepEqual(noticeFromDiskRead({ content: "x", truncated: true, bytes: 9_000_000 }), {
    truncated: true,
    bytes: 9_000_000,
  })
})
