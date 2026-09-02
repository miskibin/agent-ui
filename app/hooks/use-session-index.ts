"use client"

import * as React from "react"
import { toast } from "sonner"

import * as api from "@/lib/api-client"
import { errorMessage, nowMs, pinToTop } from "@/lib/chat-helpers"
import type { SessionMeta } from "@/lib/store/types"
import {
  CACHE_ACTIVE_KEY,
  CACHE_INDEX_KEY,
  readCache,
  writeCache,
} from "@/lib/ui-cache"

export type SessionIndex = ReturnType<typeof useSessionIndex>

/**
 * The sidebar index: which chats exist, which one is open, and the mutations
 * that only touch those two. Everything that also has to reach a thread, a
 * run or the file panel lives in `use-chat-actions` instead — this hook is
 * deliberately the layer with no other concern behind it, so the pickers
 * (`use-agent-config`) can write back through `patchLocal` without a cycle.
 */
export function useSessionIndex() {
  const [sessions, setSessions] = React.useState<SessionMeta[]>([])
  const [activeId, setActiveId] = React.useState("")
  /** False until the first `/api/sessions` answer — drives the list skeleton. */
  const [sessionsLoaded, setSessionsLoaded] = React.useState(false)
  const bootstrappedRef = React.useRef(false)

  const patchLocal = React.useCallback(
    (id: string, patch: Partial<SessionMeta>) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === id ? { ...session, ...patch } : session
        )
      )
    },
    []
  )

  /**
   * Paints the last known sidebar before the network answers. Hands the chat
   * it restored to `onSeeded` so the pickers can adopt its agent; a no-op once
   * the real index has landed.
   */
  const seedFromCache = React.useCallback(
    (
      cachedActive: string | null,
      onSeeded: (session: SessionMeta | undefined) => void
    ) => {
      if (bootstrappedRef.current) return
      const cachedSessions = readCache<SessionMeta[]>(CACHE_INDEX_KEY)
      if (!cachedSessions?.length) return
      setSessions(cachedSessions)
      const restored =
        cachedActive && cachedSessions.some((s) => s.id === cachedActive)
          ? cachedActive
          : cachedSessions[0].id
      setActiveId(restored)
      onSeeded(cachedSessions.find((s) => s.id === restored))
    },
    []
  )

  /** The real index, once `/api/sessions` answers. */
  const hydrate = React.useCallback(
    (
      list: SessionMeta[],
      cachedActive: string | null,
      onRestored: (session: SessionMeta | undefined, restored: string) => void
    ) => {
      bootstrappedRef.current = true
      setSessions(list)
      const restored =
        cachedActive && list.some((session) => session.id === cachedActive)
          ? cachedActive
          : (list[0]?.id ?? "")
      setActiveId(restored)
      onRestored(
        list.find((session) => session.id === restored),
        restored
      )
    },
    []
  )

  React.useEffect(() => {
    if (!bootstrappedRef.current) return
    writeCache(CACHE_INDEX_KEY, sessions)
  }, [sessions])

  React.useEffect(() => {
    if (activeId) writeCache(CACHE_ACTIVE_KEY, activeId)
  }, [activeId])

  const renameSession = React.useCallback(
    (id: string, title: string) => {
      patchLocal(id, { title, updatedAt: nowMs() })
      void api
        .patchSession(id, { title })
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not rename the chat"))
        )
    },
    [patchLocal]
  )

  const togglePin = React.useCallback((id: string, pinned: boolean) => {
    setSessions((prev) =>
      pinned
        ? pinToTop(prev, id)
        : prev.map((session) =>
            session.id === id ? { ...session, pinned } : session
          )
    )
    void api
      .patchSession(id, pinned ? { pinned, order: 0 } : { pinned })
      .catch((err: unknown) =>
        toast.error(errorMessage(err, "Could not update the chat"))
      )
  }, [])

  /** `/title` and the sidebar's "Regenerate title" — a model names the chat. */
  const regenerateTitle = React.useCallback(
    (id: string) => {
      const toastId = `title-${id}`
      toast.loading("Naming the chat…", { id: toastId })
      void api
        .regenerateTitle(id)
        .then((result) => {
          patchLocal(id, { title: result.title })
          toast.success(`Renamed to “${result.title}”`, { id: toastId })
        })
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not generate a title"), {
            id: toastId,
          })
        )
    },
    [patchLocal]
  )

  return {
    sessions,
    setSessions,
    activeId,
    setActiveId,
    sessionsLoaded,
    setSessionsLoaded,
    patchLocal,
    seedFromCache,
    hydrate,
    renameSession,
    togglePin,
    regenerateTitle,
  }
}
