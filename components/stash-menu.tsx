"use client"

import { Archive, Paperclip, X } from "lucide-react"
import * as React from "react"

import { chatInputButtonVariants } from "@/components/ui/chat-input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { StashEntry } from "@/lib/drafts"
import { cn } from "@/lib/utils"

/**
 * The stash button in the composer toolbar: how many prompts are parked, and
 * a list to bring one back. ⌘S in the composer is what adds to it (the
 * vendored composer's `onStash`); this only shows what is there. Hidden while
 * empty — a control for nothing is noise next to the model picker.
 */
export function StashMenu({
  entries,
  onRestore,
  onDiscard,
}: {
  entries: StashEntry[]
  onRestore: (entry: StashEntry) => void
  onDiscard: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  if (entries.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        title="Stashed prompts (⌘S to stash)"
        aria-label={`${entries.length} stashed prompts`}
        className={cn(chatInputButtonVariants(), "px-1.5")}
      >
        <Archive />
        <span className="text-[11px] tabular-nums">{entries.length}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-[12px] font-medium text-foreground">
            Stashed prompts
          </span>
          <span className="text-[11px] text-muted-foreground">
            ⌘S in the composer
          </span>
        </div>
        <ul
          data-slot="stash-list"
          className="flex max-h-72 flex-col overflow-y-auto p-1"
        >
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-slot="stash-item"
              className="group flex items-start gap-1 rounded-md transition-colors hover:bg-muted"
            >
              <button
                type="button"
                title="Restore into the composer"
                onClick={() => {
                  setOpen(false)
                  onRestore(entry)
                }}
                className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="line-clamp-2 text-[12.5px] leading-snug text-foreground">
                  {entry.text || "(attachments only)"}
                </span>
                <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <RelativeTime from={entry.createdAt} />
                  {entry.fileNames.length > 0 ? (
                    <span className="inline-flex items-center gap-0.5">
                      <Paperclip className="size-3" />
                      {entry.fileNames.length}
                      {!entry.files ? " (names only)" : null}
                    </span>
                  ) : null}
                </span>
              </button>
              <button
                type="button"
                title="Discard"
                aria-label="Discard stashed prompt"
                onClick={() => onDiscard(entry.id)}
                className="mt-1.5 mr-1 inline-grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 group-hover:opacity-100 [&_svg]:size-3.5"
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function RelativeTime({ from }: { from: number }) {
  // Read once per mount: the list mounts when the popover opens, which is
  // exactly when "3m ago" has to be right.
  const [now] = React.useState(() => Date.now())
  if (!from) return null
  const minutes = Math.max(0, Math.round((now - from) / 60_000))
  const label =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes}m ago`
        : minutes < 60 * 24
          ? `${Math.floor(minutes / 60)}h ago`
          : `${Math.floor(minutes / (60 * 24))}d ago`
  return <span>{label}</span>
}
