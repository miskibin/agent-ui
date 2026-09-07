"use client"

import * as React from "react"

import { DiffWorkerPoolProvider } from "@/components/ui/diff-worker-pool"

/**
 * The vendored worker pool, mounted only once the page is hydrated.
 *
 * `DiffWorkerPoolProvider` holds its children back until the workers answer,
 * and on the server it has no workers to wait for — so it renders the whole
 * conversation into the prerendered HTML and then, on the client's first
 * render, its fallback instead. That is a hydration mismatch, and this page is
 * prerendered. Rendering the children bare until hydration is finished lines
 * the two up: the server's markup is hydrated as it stands, and the pool takes
 * over immediately afterwards.
 *
 * `useSyncExternalStore` with a never-changing subscription is the app's own
 * idiom for "has this hydrated yet" (`components/app-header.tsx`), and the one
 * shape React guarantees will not itself warn.
 */
const subscribe = () => () => {}

export function DiffWorkers({ children }: { children: React.ReactNode }) {
  const hydrated = React.useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
  if (!hydrated) return children
  return (
    <DiffWorkerPoolProvider fallback={null}>{children}</DiffWorkerPoolProvider>
  )
}
