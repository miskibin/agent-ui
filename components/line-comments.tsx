"use client"

import { MessageSquarePlus, X } from "lucide-react"
import * as React from "react"

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

import type { ChatInputHandle } from "@/components/ui/chat-input"
import type { DiffLineCommentRange } from "@/components/ui/file-preview"
import {
  formatLineComments,
  lineCommentLabel,
  type LineComment,
} from "@/lib/line-comments"
import { cn } from "@/lib/utils"

/**
 * Lines picked in the file panel, on their way to the prompt.
 *
 * Reviewing is pointing: the reader selects lines in the diff, says one thing
 * about them, and the agent is told *where* and *what the lines said*. The
 * panel is where the pointing happens and the composer is where the prompt is
 * written, so the pending list has to be visible from both — and it belongs to
 * neither, which is why it lives in a small store of its own rather than in
 * either component's state. Nothing about it is persisted: an unsent comment is
 * a thought, not a document.
 */

type Listener = () => void

let pending: LineComment[] = []
const listeners = new Set<Listener>()
let counter = 0

/**
 * The composer this bar hands its block to. Registered by `use-file-panel`,
 * which is the one place that already holds the chat's refs — a ref rather
 * than a handle, so the registration survives the composer remounting.
 */
let composer: React.RefObject<ChatInputHandle | null> | null = null

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Every subscriber reads the same array, so the snapshot is stable per write. */
function snapshot() {
  return pending
}

const EMPTY: LineComment[] = []

export function useLineComments(): LineComment[] {
  // The server renders no chips: the list only ever exists in this tab.
  return React.useSyncExternalStore(subscribe, snapshot, () => EMPTY)
}

/** A range the panel handed over becomes a comment with nothing written yet. */
export function addLineComment(range: DiffLineCommentRange) {
  const comment: LineComment = {
    id: `line-comment-${++counter}`,
    path: range.path,
    startLine: range.startLine,
    endLine: range.endLine,
    ...(range.side ? { side: range.side } : null),
    ...(range.excerpt ? { excerpt: range.excerpt } : null),
    text: "",
  }
  pending = [...pending, comment]
  emit()
  return comment
}

export function setLineCommentText(id: string, text: string) {
  pending = pending.map((comment) =>
    comment.id === id ? { ...comment, text } : comment
  )
  emit()
}

export function removeLineComment(id: string) {
  const next = pending.filter((comment) => comment.id !== id)
  if (next.length === pending.length) return
  pending = next
  emit()
}

export function clearLineComments() {
  if (pending.length === 0) return
  pending = []
  emit()
}

/** Where "Add to prompt" writes. Cleared when the page that owned it goes away. */
export function setLineCommentComposer(
  ref: React.RefObject<ChatInputHandle | null> | null
) {
  composer = ref
}

/**
 * The pending comments as one block at the composer's caret, and the list
 * emptied behind it. Returns false when there was nothing to add or no
 * composer to add it to, so the caller can leave the chips standing.
 */
export function addLineCommentsToPrompt() {
  const handle = composer?.current
  if (!handle || pending.length === 0) return false
  const block = formatLineComments(pending)
  // A blank line after it: the block is a quote, and whatever the user types
  // next is their own sentence, not another line of it.
  handle.insertText(`${block}\n\n`)
  handle.focus()
  clearLineComments()
  return true
}

/**
 * The chips: one per pending comment, each with a line for what the reader
 * wants to say about it, and one button that puts the lot in front of the
 * prompt.
 *
 * Mounted by the chat page directly above the composer, so it sits over the
 * prompt in the same column without the page having to hold the state.
 */
export function PendingLineComments({ className }: { className?: string }) {
  const comments = useLineComments()

  const add = React.useCallback(() => {
    addLineCommentsToPrompt()
  }, [])

  if (comments.length === 0) return null

  return (
    <div
      data-slot="line-comments"
      className={cn("mx-auto w-full max-w-3xl px-3 pb-1.5 sm:px-4", className)}
    >
      <div className="flex flex-col gap-1 rounded-lg border bg-popover/95 p-1.5 shadow-xs backdrop-blur-sm">
        {comments.map((comment) => (
          <PendingLineComment key={comment.id} comment={comment} />
        ))}
        <div className="flex items-center gap-2 px-1 pt-0.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {comments.length === 1
              ? "1 comment on the file panel's lines"
              : `${comments.length} comments on the file panel's lines`}
          </span>
          <button
            type="button"
            onClick={clearLineComments}
            className="rounded-md px-1.5 py-0.5 text-[11.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            Clear
          </button>
          <button
            type="button"
            data-slot="line-comments-add"
            onClick={add}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 text-[11.5px] font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <MessageSquarePlus className="size-3" />
            Add to prompt
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * One chip. The label is the location — it is what the block will say — and
 * the input beside it is the whole comment: a line, because anything longer
 * belongs in the prompt itself, which is where this is going anyway.
 */
function PendingLineComment({ comment }: { comment: LineComment }) {
  const label = lineCommentLabel(comment)
  return (
    <div
      data-slot="line-comment"
      className="flex items-center gap-1.5 rounded-md px-1 py-0.5"
    >
      <span
        title={comment.excerpt || label}
        className="shrink-0 truncate font-mono text-[11px] text-muted-foreground"
      >
        {label}
      </span>
      <input
        value={comment.text}
        onChange={(event) => setLineCommentText(comment.id, event.target.value)}
        placeholder="What about these lines?"
        aria-label={`Comment on ${label}`}
        className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-[12px] outline-none placeholder:text-muted-foreground/70 focus-visible:bg-accent/50"
      />
      <button
        type="button"
        aria-label={`Remove the comment on ${label}`}
        onClick={() => removeLineComment(comment.id)}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
