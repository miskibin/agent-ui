"use client"

import * as React from "react"

import { nowMs, relativeTime } from "@/lib/chat-helpers"

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

export const RelativeTime = React.memo(function RelativeTime({
  from,
}: {
  from: number
}) {
  useTick(30_000)
  return <>{relativeTime(from, nowMs())}</>
})
