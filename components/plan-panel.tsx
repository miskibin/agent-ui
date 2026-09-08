"use client"

import { ClipboardList, Hammer, Loader2, X } from "lucide-react"
import * as React from "react"

import { MessageMarkdown } from "@/components/ui/message-markdown"
import { TodoList, todoProgress } from "@/components/ui/todo-list"
import type { PlanData } from "@/components/ui/plan-card"
import type { FileActionItem } from "@/components/ui/change-summary"

/**
 * The plan the agent wrote, in the panel beside the conversation.
 *
 * A plan is the one thing in a transcript that is not a record of what
 * happened but a proposal about what will — it is read, argued with, and then
 * acted on, which is reading rather than scrolling. In the message column it
 * was a card at whatever width the column happened to be, wedged between the
 * turn that produced it and the turn that follows, and a long one had to be
 * scrolled past every time the reader wanted anything else. Here it holds
 * still, at the width of a document, with the one action it leads to in the
 * header rather than at the bottom of a body you have to reach the end of.
 *
 * App-local on purpose: the vendored `PlanCard` still renders inside the
 * transcript as that turn's record, and this composes the same vendored parts
 * — the markdown, the checklist — into the host's own panel chrome. The panel
 * is the host's furniture, the way `components/file-panel.tsx` is.
 */
export function PlanPanel({
  plan,
  onBuild,
  onClose,
  busy = false,
  fileActions,
  onFileClick,
  className,
}: {
  plan: PlanData
  /** Omitted while the plan is still being written, or once it has been built. */
  onBuild?: () => void
  onClose?: () => void
  /** A turn is starting; the action locks rather than firing twice. */
  busy?: boolean
  fileActions?: FileActionItem[]
  onFileClick?: (path: string, line?: number) => void
  className?: string
}) {
  const progress = plan.todos?.length ? todoProgress(plan.todos) : null

  return (
    <aside
      data-slot="plan-panel"
      aria-label={plan.title || "Plan"}
      className={className}
    >
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header
          data-slot="plan-panel-header"
          className="flex h-10 shrink-0 items-center gap-2 border-b px-2.5 text-[13px]"
        >
          <ClipboardList className="size-3.5 shrink-0 opacity-70" />
          <span
            data-slot="plan-panel-title"
            className="min-w-0 flex-1 truncate font-medium text-foreground"
            title={plan.title || "Plan"}
          >
            {plan.title || "Plan"}
          </span>
          {progress ? (
            <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
              {progress.completed}/{progress.total}
            </span>
          ) : null}
          {/* The action the plan exists for, at the top: a long plan should not
              have to be scrolled to the end before it can be accepted. */}
          {onBuild ? (
            <button
              type="button"
              data-slot="plan-panel-build"
              onClick={onBuild}
              disabled={busy}
              className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-[12.5px] font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0"
            >
              {busy ? <Loader2 className="animate-spin" /> : <Hammer />}
              Build
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              data-slot="plan-panel-close"
              aria-label="Close the plan"
              title="Close the plan"
              onClick={onClose}
              className="inline-grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4"
            >
              <X />
            </button>
          ) : null}
        </header>

        <div
          data-slot="plan-panel-body"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3.5"
        >
          {plan.overview ? (
            <p
              data-slot="plan-panel-overview"
              className="mb-3 text-[13px] leading-snug text-muted-foreground"
            >
              {plan.overview}
            </p>
          ) : null}
          {/* The same renderer the answers use, so a path in the plan is the
              same chip — and opens the same panel — as one in a reply. */}
          <MessageMarkdown
            className="text-[13.5px]!"
            fileActions={fileActions}
            onFileClick={onFileClick}
          >
            {plan.body}
          </MessageMarkdown>
          {plan.todos?.length ? (
            <TodoList
              items={plan.todos}
              running={busy}
              data-slot="plan-panel-todos"
              className="mt-4 border-t pt-3.5"
            />
          ) : null}
        </div>
      </div>
    </aside>
  )
}
