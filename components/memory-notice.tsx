"use client"

import * as React from "react"
import Link from "next/link"
import { Brain, ChevronDown, X } from "lucide-react"

import {
  summarizeMemoryChanges,
  type MemoryChange,
} from "@/lib/memory/types"
import { cn } from "@/lib/utils"

/**
 * The "memory updated" marker, rendered inside the message list's own column
 * as a child of `MessageList` — so it sits in the conversation, after the turn
 * it belongs to, rather than floating over it as another notification.
 *
 * It is composed around the vendored list rather than added to it: this is an
 * app concern (`MessageList` knows nothing about memory), and `children` is
 * the slot the component already offers for exactly this.
 *
 * Deliberately quiet, and deliberately not a toast: a toast that fades is the
 * wrong shape for "something was written to a file that will be sent to every
 * future conversation". The user should be able to scroll back and find the
 * moment it happened, and open what changed.
 */
const EDIT_MEMORY_LINK =
  "mt-2 inline-block rounded-md text-[11px] text-muted-foreground underline underline-offset-2 transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"

export function MemoryNotice({
  changes,
  compacted,
  onDismiss,
  onOpenMemorySettings,
  className,
}: {
  changes: MemoryChange[]
  compacted?: boolean
  onDismiss: () => void
  /**
   * Opens settings on the memory section. Given by a host that shows settings
   * as a panel over the chat; without it the link navigates to `/settings`,
   * which throws away a turn the chat is still streaming.
   */
  onOpenMemorySettings?: () => void
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  if (changes.length === 0) return null

  const summary = summarizeMemoryChanges(changes)

  return (
    <div
      data-slot="memory-notice"
      className={cn("mb-4 flex flex-col items-center gap-1.5", className)}
    >
      <div className="flex items-center gap-1.5 rounded-full border bg-muted/40 py-1 pr-1 pl-2.5">
        <Brain className="size-3 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex items-center gap-1 rounded-full text-[11.5px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span>
            Memory updated
            <span className="text-muted-foreground/70"> · {summary}</span>
            {compacted ? (
              <span className="text-muted-foreground/70"> · merged to fit</span>
            ) : null}
          </span>
          <ChevronDown
            className={cn("size-3 transition-transform", open && "rotate-180")}
          />
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded-full p-0.5 text-muted-foreground/70 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <X className="size-3" />
        </button>
      </div>

      {open ? (
        <div className="w-full max-w-lg rounded-md border bg-muted/30 px-3 py-2 text-[11.5px]">
          {changes.map((change) => (
            <div key={change.category} className="not-last:mb-2">
              <p className="font-mono text-[10.5px] text-muted-foreground/70">
                {change.category}
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {change.added.map((line) => (
                  <li key={`+${line}`} className="text-foreground">
                    <span className="text-muted-foreground/70">+ </span>
                    {line}
                  </li>
                ))}
                {change.removed.map((line) => (
                  <li
                    key={`-${line}`}
                    className="text-muted-foreground line-through decoration-muted-foreground/40"
                  >
                    <span className="no-underline">− </span>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {onOpenMemorySettings ? (
            <button
              type="button"
              onClick={onOpenMemorySettings}
              className={cn(EDIT_MEMORY_LINK, "cursor-pointer")}
            >
              Edit what&apos;s remembered
            </button>
          ) : (
            <Link href="/settings#memory" className={EDIT_MEMORY_LINK}>
              Edit what&apos;s remembered
            </Link>
          )}
        </div>
      ) : null}
    </div>
  )
}
