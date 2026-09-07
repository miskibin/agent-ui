"use client"

import * as React from "react"

import { setRunningChats } from "@/components/quit-hold"
import { badgePrefix, updateAttentionBadge } from "@/lib/notifications"

/**
 * The three places the app says something is going on without stealing focus:
 * the dock badge, the tab title, and the hold-to-quit overlay.
 *
 * The badge and the title count the chats sitting on an unanswered question;
 * the title also carries the open chat's name. The running count is the other
 * half — how many turns are in flight — and it goes to `components/quit-hold`,
 * which is mounted in the root layout, above this page and outside every
 * provider it owns, through the module store that exists for exactly that.
 */
export function useAttention({
  waitingCount,
  runningCount,
  activeTitle,
}: {
  waitingCount: number
  /** Turns in flight, across every chat — what ⌘Q is held for. */
  runningCount: number
  activeTitle: string
}) {
  React.useEffect(() => {
    updateAttentionBadge(waitingCount)
    setRunningChats(runningCount)
  }, [runningCount, waitingCount])

  React.useEffect(() => {
    document.title = `${badgePrefix(waitingCount)}${
      activeTitle ? `${activeTitle} — Agent UI` : "Agent UI"
    }`
  }, [activeTitle, waitingCount])
}
