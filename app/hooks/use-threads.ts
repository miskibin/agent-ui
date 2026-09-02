"use client"

import * as React from "react"
import { toast } from "sonner"

import * as api from "@/lib/api-client"
import { errorMessage } from "@/lib/chat-helpers"
import type { StoredMessage } from "@/lib/store/types"

import type { ChatRefs } from "./use-chat-refs"

/** Active/running transcripts plus this many recently opened bodies stay hot. */
const MAX_CACHED_THREADS = 4

export type Threads = ReturnType<typeof useThreads>

/**
 * The transcripts themselves, loaded lazily per chat and kept on a tiny LRU:
 * opening chats must not retain every transcript for the lifetime of the
 * WebView, while the open one and anything still streaming are protected.
 */
export function useThreads(refs: ChatRefs) {
  const { activeIdRef, threadsRef, abortsRef } = refs
  /** Thread bodies, loaded lazily per session. `undefined` = not loaded yet. */
  const [threads, setThreads] = React.useState<
    Record<string, StoredMessage[]>
  >({})
  const inflightRef = React.useRef(new Set<string>())
  const threadAccessRef = React.useRef<string[]>([])

  const cacheThread = React.useCallback(
    (
      current: Record<string, StoredMessage[]>,
      id: string,
      body: StoredMessage[]
    ) => {
      const access = threadAccessRef.current.filter((entry) => entry !== id)
      access.push(id)
      threadAccessRef.current = access

      const next = { ...current, [id]: body }
      let count = Object.keys(next).length
      if (count <= MAX_CACHED_THREADS) return next

      const protectedIds = new Set([
        id,
        activeIdRef.current,
        ...abortsRef.current.keys(),
      ])
      for (const candidate of access) {
        if (count <= MAX_CACHED_THREADS) break
        if (protectedIds.has(candidate) || next[candidate] === undefined)
          continue
        delete next[candidate]
        count--
      }
      threadAccessRef.current = access.filter(
        (entry) => next[entry] !== undefined
      )
      return next
    },
    [abortsRef, activeIdRef]
  )

  const loadThread = React.useCallback(
    async (id: string) => {
      if (!id) return
      if (threadsRef.current[id] !== undefined) return
      if (inflightRef.current.has(id)) return
      inflightRef.current.add(id)
      try {
        const loaded = await api.fetchMessages(id)
        // A run may have seeded the thread while this was in flight.
        setThreads((prev) =>
          prev[id] !== undefined ? prev : cacheThread(prev, id, loaded)
        )
      } catch (err) {
        toast.error(errorMessage(err, "Could not load this chat"))
      } finally {
        inflightRef.current.delete(id)
      }
    },
    [cacheThread, threadsRef]
  )

  return { threads, setThreads, cacheThread, loadThread }
}
