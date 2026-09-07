// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * Notes a reader left on specific lines, and the block they become in front of
 * a prompt.
 *
 * The point of quoting is that the agent is not looking at the panel: "this is
 * wrong" means nothing on its own, and a line number means nothing either once
 * the file has moved under it. So a comment travels as three things — where it
 * was made, what the lines said when it was made, and what the reader wrote —
 * and the excerpt is what survives the file changing underneath.
 *
 * Pure on purpose: the formatting is the part worth testing, and nothing here
 * touches React, the DOM or the store that holds the pending list.
 */

export type LineComment = {
  id: string
  /** As the panel named it — usually relative to the chat's folder. */
  path: string
  /** 1-based and inclusive, in the numbering of `side`. */
  startLine: number
  endLine: number
  /** Which version of the file the numbers belong to, when it was a diff. */
  side?: "old" | "new"
  /** The lines themselves, as they read when the comment was made. */
  excerpt?: string
  /** What the reader wrote. May be empty — pointing at lines is a comment too. */
  text: string
}

/** `120`, or `120-134`. */
export function lineCommentRange(comment: LineComment): string {
  return comment.startLine === comment.endLine
    ? `${comment.startLine}`
    : `${comment.startLine}-${comment.endLine}`
}

/** `lib/git-commit.ts:120-134` — what the chip says, and what the block leads with. */
export function lineCommentLabel(comment: LineComment): string {
  return `${comment.path}:${lineCommentRange(comment)}`
}

/**
 * The fence language for an excerpt, from the file's own name. A dotfile is
 * named by what follows the dot (`.gitignore` → `gitignore`); anything else
 * falls back to no language rather than a wrong one.
 */
export function fenceLanguage(path: string): string {
  const name = path
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .toLowerCase()
  const dot = name.lastIndexOf(".")
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1)
  if (name.startsWith(".") && name.length > 1) return name.slice(1)
  return ""
}

/**
 * A fence long enough to hold this text. An excerpt is code the reader picked
 * out of a file, and a file is free to contain a fence of its own — three
 * backticks inside the quote would end the block early and spill the rest of
 * it into the prompt as prose.
 */
export function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return "`".repeat(Math.max(3, longest + 1))
}

/** One comment: the location, what was written, and the lines it was written about. */
function formatOne(comment: LineComment): string {
  const written = comment.text.trim()
  const head = written
    ? `${lineCommentLabel(comment)} — ${written}`
    : lineCommentLabel(comment)
  const excerpt = comment.excerpt?.replace(/\s+$/, "")
  if (!excerpt) return head
  const fence = fenceFor(excerpt)
  return [head, `${fence}${fenceLanguage(comment.path)}`, excerpt, fence].join("\n")
}

/**
 * The block a pending list becomes when the reader sends it: one heading, then
 * a paragraph per comment. Deterministic, in the order the comments were made
 * — an agent reading it should be able to walk the file top to bottom in the
 * order the reader did.
 *
 * Empty in, empty out: the caller appends nothing rather than a stray heading.
 */
export function formatLineComments(
  comments: readonly LineComment[]
): string {
  if (comments.length === 0) return ""
  const heading =
    comments.length === 1
      ? "Comment on the lines below:"
      : "Comments on the lines below:"
  return [heading, ...comments.map(formatOne)].join("\n\n")
}
