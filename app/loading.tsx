import { Skeleton } from "@/components/ui/skeleton"

/**
 * What the window shows while the chat chunk loads.
 *
 * The chat page is a pure client component, so until its JavaScript arrives
 * there is nothing to paint. This is the same shell in static markup — sidebar
 * column, 12px-tall header, empty transcript — so the first frame is the app's
 * own furniture rather than a blank page, and the swap to the real header
 * moves nothing. The window-control strip is reserved on the same
 * `data-desktop` flag the real header uses.
 */
export default function Loading() {
  return (
    <div
      aria-busy
      aria-label="Loading"
      className="flex h-full min-h-0 overflow-hidden bg-background"
    >
      <div className="hidden h-full w-[290px] shrink-0 flex-col gap-2 border-r border-sidebar-border bg-sidebar p-3 md:flex">
        <Skeleton className="h-6 w-20 opacity-60" />
        <Skeleton className="mt-2 h-8 w-full opacity-50" />
        <Skeleton className="h-8 w-full opacity-40" />
        <Skeleton className="mt-3 h-3 w-24 opacity-40" />
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} className="h-9 w-full opacity-30" />
        ))}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 w-full shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 sm:gap-3 sm:px-4">
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Skeleton className="size-8 opacity-40" />
            <Skeleton className="size-8 opacity-40" />
            <Skeleton className="size-8 opacity-40" />
          </div>
          <div
            aria-hidden
            data-slot="window-controls-reserve"
            className="-mr-3 ml-2 h-12 w-[140px] shrink-0 self-stretch border-l sm:-mr-4"
          />
        </header>

        <div className="flex min-h-0 flex-1 flex-col justify-center">
          <div className="mx-auto w-full max-w-3xl px-3 pb-5 sm:px-4">
            <Skeleton className="mx-auto h-7 w-52 opacity-40" />
          </div>
          <div className="mx-auto w-full max-w-3xl px-3 sm:px-4">
            <Skeleton className="h-24 w-full rounded-2xl opacity-40" />
          </div>
        </div>
      </div>
    </div>
  )
}
