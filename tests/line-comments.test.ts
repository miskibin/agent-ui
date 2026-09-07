import test from "node:test"
import assert from "node:assert/strict"

import {
  fenceFor,
  fenceLanguage,
  formatLineComments,
  lineCommentLabel,
  lineCommentRange,
  type LineComment,
} from "@/lib/line-comments"

const comment = (patch: Partial<LineComment> = {}): LineComment => ({
  id: "c1",
  path: "lib/git-commit.ts",
  startLine: 120,
  endLine: 134,
  text: "bail out before staging",
  excerpt: "  const staged = await run(cwd)",
  ...patch,
})

test("a range names one line or a span", () => {
  assert.equal(lineCommentRange(comment()), "120-134")
  assert.equal(lineCommentRange(comment({ endLine: 120 })), "120")
  assert.equal(lineCommentLabel(comment({ endLine: 120 })), "lib/git-commit.ts:120")
})

test("the fence language comes from the file name, dotfiles included", () => {
  assert.equal(fenceLanguage("lib/git-commit.ts"), "ts")
  assert.equal(fenceLanguage("C:\\repo\\app\\page.tsx"), "tsx")
  assert.equal(fenceLanguage(".gitignore"), "gitignore")
  assert.equal(fenceLanguage("Makefile"), "")
})

test("the fence outgrows any backtick run inside the excerpt", () => {
  assert.equal(fenceFor("plain code"), "```")
  assert.equal(fenceFor("const md = ```fenced```"), "````")
  assert.equal(fenceFor("`````"), "``````")
})

test("an empty list adds nothing to the prompt", () => {
  assert.equal(formatLineComments([]), "")
})

test("one comment is its location, the note, and the lines it names", () => {
  assert.equal(
    formatLineComments([comment()]),
    [
      "Comment on the lines below:",
      "",
      "lib/git-commit.ts:120-134 — bail out before staging",
      "```ts",
      "  const staged = await run(cwd)",
      "```",
    ].join("\n")
  )
})

test("a comment with no words is still a comment, and an excerpt-less one is one line", () => {
  assert.equal(
    formatLineComments([comment({ text: "   " })]),
    ["Comment on the lines below:", "", "lib/git-commit.ts:120-134", "```ts", "  const staged = await run(cwd)", "```"].join(
      "\n"
    )
  )
  assert.equal(
    formatLineComments([comment({ excerpt: "", text: "why?" })]),
    ["Comment on the lines below:", "", "lib/git-commit.ts:120-134 — why?"].join("\n")
  )
})

test("comments keep the order they were made in, one paragraph each", () => {
  const block = formatLineComments([
    comment({ id: "a", text: "first" }),
    comment({
      id: "b",
      path: "app/page.tsx",
      startLine: 12,
      endLine: 12,
      text: "second",
      excerpt: "import { X } from 'lucide-react'",
    }),
  ])
  assert.match(block, /^Comments on the lines below:/)
  assert.ok(
    block.indexOf("lib/git-commit.ts:120-134") <
      block.indexOf("app/page.tsx:12"),
    "the block should read in the order the reader commented"
  )
  assert.match(block, /```tsx\nimport \{ X \} from 'lucide-react'\n```/)
})

test("an excerpt carrying its own fence cannot close the block early", () => {
  const block = formatLineComments([
    comment({ excerpt: "```\nnot the end\n```", text: "nested" }),
  ])
  // The fence around the excerpt is longer than anything inside it.
  const fence = block.match(/\n(`{4,})ts\n/)
  assert.ok(fence, "the opening fence should be at least four backticks")
  assert.ok(block.endsWith(fence![1]), "and the closing fence should match it")
})
