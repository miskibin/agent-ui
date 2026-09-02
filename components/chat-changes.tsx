"use client"

import { FileDiff } from "lucide-react"
import * as React from "react"

import { AppHeaderButton } from "@/components/app-header"
import {
  ChangeSummary,
  fileChangesFromTools,
  type ChangeSummaryFile,
  type FileActionItem,
} from "@/components/ui/change-summary"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { toolsFromParts } from "@/lib/message-stream"
import type { StoredMessage } from "@/lib/store/types"

/**
 * Every file the chat has changed, across all of its turns — the "whole
 * thread" scope next to the per-turn card under each answer. Lives in the
 * header as a count; opens the same card the turns use, so a row here opens
 * the same panel and carries the same right-click menu.
 */

/**
 * Union of every settled turn's change card, stats summed per path. A turn
 * carries an explicit `changes` list only when `lib/turn-files` had something
 * to add; otherwise its card is derived from the mutation tools, the way
 * `Message` derives it, so the two never disagree.
 */
export function collectChatChanges(messages: StoredMessage[]): ChangeSummaryFile[] {
  const byPath = new Map<string, ChangeSummaryFile>()
  for (const message of messages) {
    if (message.sender !== "assistant") continue
    const changes =
      message.changes ??
      fileChangesFromTools(
        message.tools?.length ? message.tools : toolsFromParts(message.parts ?? [])
      )
    for (const change of changes) {
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

export function ChatChanges({
  files,
  fileActions,
  onFileClick,
}: {
  files: ChangeSummaryFile[]
  fileActions?: FileActionItem[]
  onFileClick: (file: ChangeSummaryFile) => void
}) {
  const [open, setOpen] = React.useState(false)
  const select = React.useCallback(
    (file: ChangeSummaryFile) => {
      setOpen(false)
      onFileClick(file)
    },
    [onFileClick]
  )
  if (files.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <AppHeaderButton
          label={`${files.length} ${files.length === 1 ? "file" : "files"} changed in this chat`}
        >
          <FileDiff />
          <span className="text-[11px] tabular-nums">{files.length}</span>
        </AppHeaderButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <ChangeSummary
          files={files}
          title="Changed in this chat"
          actionLabel=""
          previewCount={12}
          fileActions={fileActions}
          onFileClick={select}
          className="max-w-none rounded-md border-0"
        />
      </PopoverContent>
    </Popover>
  )
}
