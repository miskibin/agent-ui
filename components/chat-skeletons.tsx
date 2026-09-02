import * as React from "react"

import { Skeleton } from "@/components/ui/skeleton"

/** Cold start: the chat list is still in flight, so show rows, not "empty". */
export const SidebarLoading = React.memo(function SidebarLoading() {
  return (
    <div aria-busy className="flex flex-col gap-1 px-1 py-1">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-9 w-full opacity-40" />
      ))}
    </div>
  )
})

/** The transcript of a chat that is being read back from disk. */
export const ThreadLoading = React.memo(function ThreadLoading() {
  return (
    <div
      aria-busy
      aria-label="Loading the chat"
      className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col gap-7 overflow-hidden px-3 py-6 sm:px-4"
    >
      {[0, 1].map((turn) => (
        <React.Fragment key={turn}>
          <Skeleton className="ml-auto h-9 w-56 rounded-2xl opacity-40" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-[85%] opacity-30" />
            <Skeleton className="h-3.5 w-[70%] opacity-30" />
            <Skeleton className="h-3.5 w-[45%] opacity-30" />
          </div>
        </React.Fragment>
      ))}
    </div>
  )
})
