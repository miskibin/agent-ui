"use client"

import * as React from "react"

import { badgePrefix, updateAttentionBadge } from "@/lib/notifications"

/**
 * The two places the app says something is waiting on you without stealing
 * focus: the dock badge, and the tab title. Both count the chats sitting on an
 * unanswered question; the title also carries the open chat's name.
 */
export function useAttention({
  waitingCount,
  activeTitle,
}: {
  waitingCount: number
  activeTitle: string
}) {
  React.useEffect(() => {
    updateAttentionBadge(waitingCount)
  }, [waitingCount])

  React.useEffect(() => {
    document.title = `${badgePrefix(waitingCount)}${
      activeTitle ? `${activeTitle} — Agent UI` : "Agent UI"
    }`
  }, [activeTitle, waitingCount])
}
