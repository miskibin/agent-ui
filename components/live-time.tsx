"use client"

import * as React from "react"

import { formatElapsed, nowMs, relativeTime } from "@/lib/chat-helpers"
import { cn } from "@/lib/utils"

/**
 * A live label owns its own tick. A single page-level clock re-rendered the
 * whole app — sidebar, composer and message list included — once a second for
 * the sake of one "12s" string.
 */
function useTick(everyMs: number) {
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
}

export const WorkingFor = React.memo(function WorkingFor({
  startedAt,
  dim,
}: {
  startedAt: number
  dim: boolean
}) {
  useTick(1_000)
  return (
    <span className={cn("font-medium text-primary", dim && "opacity-75")}>
      Working · {formatElapsed(startedAt, nowMs())}
    </span>
  )
})

export const RelativeTime = React.memo(function RelativeTime({
  from,
}: {
  from: number
}) {
  useTick(30_000)
  return <>{relativeTime(from, nowMs())}</>
})
