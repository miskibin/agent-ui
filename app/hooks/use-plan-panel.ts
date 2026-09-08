"use client"

import * as React from "react"

import type { ThreadPlan } from "@/lib/todo-plan"

/**
 * Whether the side panel is showing the chat's plan.
 *
 * The plan opens itself. A harness that has just written one has stopped to
 * ask for a decision, and the decision is the point — so it arrives in the
 * panel rather than waiting to be found in the transcript. That happens once
 * per plan: dismissing it is remembered against the tool call that wrote it,
 * so a stream that keeps re-rendering the same plan does not keep reopening a
 * panel the user closed. A *new* plan opens again, because it is a new
 * question.
 *
 * The file panel wins the space when both want it — a file is opened by a
 * click and a plan by the agent, and a click is the more recent intent. The
 * plan is not closed by that, only covered: closing the file brings it back.
 */
export function usePlanPanel({
  activeId,
  plan,
}: {
  activeId: string
  /** The plan the open chat is on, from `livePlan`. */
  plan: ThreadPlan | null
}) {
  const [dismissed, setDismissed] = React.useState<string | null>(null)

  /** Identity of the plan on screen: a new tool call is a new plan. */
  const key = plan ? `${activeId}:${plan.messageId}:${plan.toolId}` : null

  const close = React.useCallback(() => {
    setDismissed(key)
  }, [key])

  /**
   * The transcript row handing the reader back. It takes the plan it was
   * clicked on so the callback can stay stable across renders, but only the
   * live plan can be reopened — the row for an older one is a compact record
   * of where a plan was written, and the panel would have nothing to offer for
   * it but a Build button aimed at the wrong turn.
   */
  const open = React.useCallback(() => {
    setDismissed(null)
  }, [])

  /**
   * Nothing resets this on a chat switch, and nothing needs to: the key
   * carries the chat id, so a dismissal made in one chat can never match
   * another chat's plan. One stale string is cheaper than an effect — and
   * `setState` in an effect body is what the hooks rules forbid outright.
   */
  return {
    /** The plan to render, or null — closed, or there is none. */
    openPlan: key && dismissed !== key ? plan : null,
    closePlan: close,
    reopenPlan: open,
  }
}
