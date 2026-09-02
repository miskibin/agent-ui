import assert from "node:assert/strict"
import { test } from "node:test"

import { linkLocalImages } from "@/lib/local-media"
import type { StoredMessage } from "@/lib/store/types"
import { turnFiles } from "@/lib/turn-files"

/**
 * The turn's file card, widened past what a mutation tool edited to what the
 * run actually produced.
 *
 * `@/components/ui/change-summary` and `@/components/ui/message-parts` are
 * `.tsx`, which Node's strip-only loader cannot parse, so the runner resolves
 * them to copies of their pure helpers under `tests/stubs` — see the note in
 * `tests/alias-hook.mjs`. Everything asserted below is `lib/turn-files`' own
 * logic.
 */

function assistant(extra: Partial<StoredMessage> = {}): StoredMessage {
  return { id: "m1", sender: "assistant", content: "", ...extra }
}

function tool(name: string, input: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: `${name}-1`,
    name,
    status: "done" as const,
    input: JSON.stringify(input),
    ...extra,
  }
}

test("a turn that only edited files adds nothing to the card", () => {
  const message = assistant({
    tools: [tool("Edit", { path: "app/page.tsx", diff: "+a\n-b" }, { output: "+1 −1" })],
    content: "Edited `app/page.tsx`.",
  })
  // Undefined, not an empty array: the component derives the card itself, and
  // the message object must stay identical so the memoized row does not
  // re-render.
  assert.equal(turnFiles(message), undefined)
})

test("a user message never has a card", () => {
  assert.equal(turnFiles({ id: "u1", sender: "user", content: "`plot.png`" }), undefined)
})

test("an image a tool opened is added after the edits", () => {
  const rows = turnFiles(
    assistant({
      tools: [
        tool("Edit", { path: "make_plot.py" }, { output: "+10 −0" }),
        tool("Read", { path: "/home/me/out/plot.png" }),
      ],
    })
  )
  assert.deepEqual(rows?.map((file) => file.path), ["make_plot.py", "/home/me/out/plot.png"])
  // Nothing diffed it, so it carries no stats.
  assert.equal(rows?.[1].additions, undefined)
})

test("a tool that has not finished is not counted", () => {
  assert.equal(
    turnFiles(
      assistant({ tools: [{ ...tool("Read", { path: "/out/plot.png" }), status: "running" }] })
    ),
    undefined
  )
})

test("an image the answer embeds is added even when no tool named it", () => {
  const rows = turnFiles(
    assistant({ content: linkLocalImages("Here:\n\n![chart](/home/me/out/plot.png)") })
  )
  assert.deepEqual(rows?.map((file) => file.path), ["/home/me/out/plot.png"])
})

test("a file the answer merely names is added only when it is an artifact", () => {
  const rows = turnFiles(
    assistant({
      content: "I wrote `wykres.png` and `data.csv` by editing `app/page.tsx` — see `lib/utils.ts`.",
    })
  )
  assert.deepEqual(rows?.map((file) => file.path), ["wykres.png", "data.csv"])
})

test("code fences are not mined for file names", () => {
  assert.equal(
    turnFiles(assistant({ content: "```bash\ncat wykres.png\n```\nDone." })),
    undefined
  )
  // Nor is a chip that is really a sentence.
  assert.equal(turnFiles(assistant({ content: "`the chart.png file`" })), undefined)
})

test("one file named two ways is one row", () => {
  const rows = turnFiles(
    assistant({
      tools: [tool("Read", { path: "D:\\work\\out\\wykres.png" })],
      content: "The chart is `wykres.png`, and here it is:\n\n" +
        linkLocalImages("![](D:\\work\\out\\wykres.png)"),
    })
  )
  assert.deepEqual(rows?.map((file) => file.path), ["D:\\work\\out\\wykres.png"])
})

test("an edited file the answer also names does not gain a second row", () => {
  const rows = turnFiles(
    assistant({
      tools: [
        tool("Write", { path: "/home/me/p/out/report.pdf" }, { output: "+1 −0" }),
        tool("Read", { path: "/home/me/p/out/plot.png" }),
      ],
      content: "Wrote `report.pdf`.",
    })
  )
  assert.deepEqual(rows?.map((file) => file.path), [
    "/home/me/p/out/report.pdf",
    "/home/me/p/out/plot.png",
  ])
})

test("the tools are read off the parts when the message has no tool list", () => {
  const rows = turnFiles(
    assistant({
      parts: [
        { type: "tool", id: "t1", tool: tool("Read", { path: "/out/plot.png" }) },
        { type: "text", id: "x1", text: "Done — `data.csv` too." },
      ],
    })
  )
  assert.deepEqual(rows?.map((file) => file.path), ["/out/plot.png", "data.csv"])
})
