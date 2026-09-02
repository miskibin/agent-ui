"use client"

import * as React from "react"
import { ChevronDown, GitCompareArrows } from "lucide-react"

import type { HandoffMarker } from "@/lib/handoff/types"
import { cn } from "@/lib/utils"

/**
 * The "this turn was handed a handoff" marker, rendered under the turn it
 * belongs to through `MessageList`'s own `renderActions` slot — so it sits in
 * the conversation, attached to the answer it explains, and the vendored list
 * stays untouched.
 *
 * The same stance as `memory-notice`, for the same reason: something was
 * silently added to a prompt, and the user should be able to scroll back,
 * find the moment, and read the exact text the agent was sent. It is a
 * sibling of that marker, not a copy of it — memory is durable and about the
 * user, this is ephemeral and about the other agents in this chat.
 */
export const HandoffNotice = React.memo(function HandoffNotice({
  handoff,
  className,
}: {
  handoff: HandoffMarker
  className?: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <div
      data-slot="handoff-notice"
      data-stale={handoff.staleWorktree ? "true" : undefined}
      className={cn("mt-1 mb-2 flex flex-col items-start gap-1.5", className)}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-slot="handoff-notice-trigger"
        className="flex items-center gap-1.5 rounded-full border bg-muted/40 py-1 pr-2 pl-2.5 text-[11.5px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <GitCompareArrows className="size-3 shrink-0" />
        <span>
          Handed off
          <span className="text-muted-foreground/70"> · {summary(handoff)}</span>
        </span>
        <ChevronDown
          className={cn("size-3 transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <pre
          data-slot="handoff-notice-body"
          className="max-h-80 w-full max-w-lg overflow-auto rounded-md border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground"
        >
          {handoff.text}
        </pre>
      ) : null}
    </div>
  )
})

/** What the collapsed row says — counts first, the warning last and loudest. */
function summary(handoff: HandoffMarker) {
  const parts: string[] = []
  if (handoff.files > 0) parts.push(plural(handoff.files, "file"))
  if (handoff.commands > 0) parts.push(plural(handoff.commands, "command"))
  if (handoff.errors > 0) parts.push(plural(handoff.errors, "error"))
  if (handoff.staleWorktree) parts.push("tree changed")
  return parts.length > 0 ? parts.join(" · ") : "context from another agent"
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}
