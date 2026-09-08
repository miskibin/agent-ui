"use client"

import { FileDiff } from "lucide-react"

import { AppHeaderButton } from "@/components/app-header"
import {
  fileChangesFromTools,
  type ChangeSummaryFile,
} from "@/components/ui/change-summary"
import { toolsFromParts } from "@/lib/message-stream"
import type { StoredMessage } from "@/lib/store/types"

/**
 * Every file the chat has changed, across all of its turns — the "whole
 * thread" scope next to the per-turn card under each answer. Lives in the
 * header as a count; opens a tree of those files, so a row here opens the
 * same panel and carries the same right-click menu.
 */

/**
 * Union of every settled turn's change card, stats summed per path. A turn
 * carries an explicit `changes` list only when `lib/turn-files` had something
 * to add; otherwise its card is derived here the way `Message` derives it, so
 * the two never disagree — including the one thing that outranks both, the
 * turn's own worktree checkpoint (`lib/checkpoints`), which is a measured diff
 * rather than a claim made by a tool call.
 */
const derivedChanges = new WeakMap<StoredMessage, ChangeSummaryFile[]>()

/** A settled message's list, parsed once: the union is rebuilt per frame. */
function changesOf(message: StoredMessage): ChangeSummaryFile[] {
  if (message.changes) return message.changes
  const cached = derivedChanges.get(message)
  if (cached) return cached
  const measured = message.metadata?.checkpoint?.files
  const changes = measured
    ? measured.map((file) => ({
        path: file.path,
        additions: file.insertions,
        deletions: file.deletions,
      }))
    : fileChangesFromTools(
        message.tools?.length ? message.tools : toolsFromParts(message.parts ?? [])
      )
  derivedChanges.set(message, changes)
  return changes
}

export function collectChatChanges(messages: StoredMessage[]): ChangeSummaryFile[] {
  const byPath = new Map<string, ChangeSummaryFile>()
  for (const message of messages) {
    if (message.sender !== "assistant") continue
    for (const change of changesOf(message)) {
      const existing = byPath.get(change.path)
      if (existing) {
        existing.additions = (existing.additions ?? 0) + (change.additions ?? 0)
        existing.deletions = (existing.deletions ?? 0) + (change.deletions ?? 0)
      } else {
        byPath.set(change.path, { ...change })
      }
    }
  }
  return [...byPath.values()]
}

/**
 * The chat's changed-file count, in the header, and the way into the review.
 *
 * It used to open a popover holding a file tree and the commit controls — the
 * right shape for going *to* a file, and the wrong one for reading a change:
 * the reader opened eight files in turn to see what a turn had done and lost
 * their place in each. The tree, the commit controls and now the diffs
 * themselves live in `components/changes-panel.tsx` instead, beside the
 * conversation, where there is room for the content. This is the button.
 */
export function ChatChanges({
  files,
  open,
  onToggle,
}: {
  files: ChangeSummaryFile[]
  /** The panel is showing this chat's changes. */
  open: boolean
  onToggle: () => void
}) {
  if (files.length === 0) return null

  return (
    <AppHeaderButton
      label={`${files.length} ${files.length === 1 ? "file" : "files"} changed in this chat`}
      aria-expanded={open}
      data-active={open || undefined}
      onClick={onToggle}
      className="data-[active=true]:bg-muted data-[active=true]:text-foreground"
    >
      <FileDiff />
      <span className="text-[11px] tabular-nums">{files.length}</span>
    </AppHeaderButton>
  )
}
