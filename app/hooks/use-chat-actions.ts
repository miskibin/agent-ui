"use client"

import * as React from "react"
import { toast } from "sonner"

import * as api from "@/lib/api-client"
import { errorMessage, omit } from "@/lib/chat-helpers"
import { clearDraft } from "@/lib/drafts"
import { runLayoutTransition } from "@/lib/layout-transition"
import type { PermissionMode, ProviderInfo } from "@/lib/providers/types"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"

import type { QueuedMessage, SessionRun } from "./chat-types"
import type { ChatRefs } from "./use-chat-refs"
import type { LoadThread } from "./use-threads"

/**
 * The mutations that cross concerns: opening a chat has to re-point the
 * pickers and close the file panel, deleting one has to drop its thread, its
 * queue, its draft and any run it had. They live here rather than in
 * `use-session-index` because that hook is deliberately the layer with nothing
 * behind it — everything these reach into is built on top of it.
 */
export function useChatActions({
  refs,
  sessions,
  activeId,
  activeFolder,
  openThreadLength,
  providerId,
  model,
  chosenPermission,
  setSessions,
  setActiveId,
  setThreads,
  setRuns,
  setFailures,
  setQueues,
  patchLocal,
  cacheThread,
  loadThread,
  adoptAgent,
  closePreview,
  closeNav,
  forgetDraft,
}: {
  refs: ChatRefs
  sessions: SessionMeta[]
  activeId: string
  /** The open chat's working folder, trimmed — "" when it has none yet. */
  activeFolder: string
  /** Length of the open chat's thread — decides whether a new chat animates. */
  openThreadLength: number
  providerId: string
  model: string
  chosenPermission: PermissionMode | ""
  setSessions: React.Dispatch<React.SetStateAction<SessionMeta[]>>
  setActiveId: React.Dispatch<React.SetStateAction<string>>
  setThreads: React.Dispatch<
    React.SetStateAction<Record<string, StoredMessage[]>>
  >
  setRuns: React.Dispatch<React.SetStateAction<Record<string, SessionRun>>>
  setFailures: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  setQueues: React.Dispatch<
    React.SetStateAction<Record<string, QueuedMessage[]>>
  >
  patchLocal: (id: string, patch: Partial<SessionMeta>) => void
  cacheThread: (
    current: Record<string, StoredMessage[]>,
    id: string,
    body: StoredMessage[]
  ) => Record<string, StoredMessage[]>
  loadThread: LoadThread
  adoptAgent: (
    session: SessionMeta | undefined,
    list: ProviderInfo[],
    fallback?: string
  ) => void
  closePreview: () => void
  closeNav: () => void
  /** Drops a deleted chat's parked draft — see `use-composer-drafts`. */
  forgetDraft: (id: string) => void
}) {
  const {
    abortsRef,
    activeIdRef,
    providerIdRef,
    providersRef,
    selectSessionRef,
    sessionsRef,
    threadsRef,
  } = refs

  const selectSession = React.useCallback(
    (id: string) => {
      // Background chats keep streaming — selecting never aborts a run.
      closeNav()
      const current = activeIdRef.current
      if (current !== id) {
        // The open file belongs to a turn in the chat being left behind.
        closePreview()
        // Crossing between the centered opening and a thread slides the composer.
        const from = threadsRef.current[current]?.length ?? 0
        const to = threadsRef.current[id]?.length ?? 0
        if ((from === 0) !== (to === 0)) {
          runLayoutTransition(() => setActiveId(id))
        } else {
          setActiveId(id)
        }
        // Each chat keeps the agent it was last run with.
        adoptAgent(
          sessionsRef.current.find((session) => session.id === id),
          providersRef.current,
          providerIdRef.current
        )
      }
      const cached = threadsRef.current[id]
      if (cached !== undefined) {
        setThreads((prev) => cacheThread(prev, id, cached))
      }
      void loadThread(id)
    },
    [
      activeIdRef,
      adoptAgent,
      cacheThread,
      closeNav,
      closePreview,
      loadThread,
      providerIdRef,
      providersRef,
      sessionsRef,
      setActiveId,
      setThreads,
      threadsRef,
    ]
  )
  React.useEffect(() => {
    selectSessionRef.current = selectSession
  }, [selectSession, selectSessionRef])

  /**
   * The chat's working folder. A chat that does not exist yet (the very first
   * one, before anything is sent) is created with the folder already on it, so
   * picking a folder is never lost.
   */
  const setFolder = React.useCallback(
    (next: { cwd: string; gitBranch: string }) => {
      const sessionId = activeIdRef.current
      if (!sessionId) {
        void api
          .createSession({
            providerId,
            model,
            permissionMode: chosenPermission || undefined,
            ...next,
          })
          .then((created) => {
            setSessions((prev) => [created, ...prev])
            setThreads((prev) => ({ ...prev, [created.id]: [] }))
            setActiveId(created.id)
          })
          .catch((err: unknown) =>
            toast.error(errorMessage(err, "Could not start a new chat"))
          )
        return
      }
      patchLocal(sessionId, next)
      void api
        .patchSession(sessionId, next)
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not set the folder"))
        )
    },
    [
      activeIdRef,
      chosenPermission,
      model,
      patchLocal,
      providerId,
      setActiveId,
      setSessions,
      setThreads,
    ]
  )

  const removeSession = React.useCallback(
    (id: string) => {
      if (activeIdRef.current === id) closePreview()
      abortsRef.current.get(id)?.abort()
      abortsRef.current.delete(id)
      setQueues((prev) => omit(prev, id))
      forgetDraft(id)
      clearDraft(id)
      setThreads((prev) => {
        if (prev[id] === undefined) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      setRuns((prev) => omit(prev, id))
      setFailures((prev) => omit(prev, id))
      setSessions((prev) => {
        const next = prev.filter((session) => session.id !== id)
        setActiveId((current) =>
          current === id ? (next[0]?.id ?? "") : current
        )
        return next
      })
      void api
        .deleteSession(id)
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not delete the chat"))
        )
    },
    [
      abortsRef,
      activeIdRef,
      closePreview,
      forgetDraft,
      setActiveId,
      setFailures,
      setQueues,
      setRuns,
      setSessions,
      setThreads,
    ]
  )

  const removeSessions = React.useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return
      const idSet = new Set(ids)
      for (const id of ids) {
        abortsRef.current.get(id)?.abort()
        abortsRef.current.delete(id)
        forgetDraft(id)
        clearDraft(id)
      }
      setQueues((prev) => {
        let next = prev
        for (const id of ids) next = omit(next, id)
        return next
      })
      setThreads((prev) => {
        let changed = false
        const next = { ...prev }
        for (const id of ids) {
          if (next[id] === undefined) continue
          delete next[id]
          changed = true
        }
        return changed ? next : prev
      })
      setRuns((prev) => {
        let next = prev
        for (const id of ids) next = omit(next, id)
        return next
      })
      setFailures((prev) => {
        let next = prev
        for (const id of ids) next = omit(next, id)
        return next
      })
      setSessions((prev) => {
        const next = prev.filter((session) => !idSet.has(session.id))
        setActiveId((current) =>
          idSet.has(current) ? (next[0]?.id ?? "") : current
        )
        return next
      })
      for (const id of ids) {
        void api
          .deleteSession(id)
          .catch((err: unknown) =>
            toast.error(errorMessage(err, "Could not delete the chat"))
          )
      }
      toast.message(
        ids.length === 1 ? "Chat deleted" : `${ids.length} chats deleted`
      )
    },
    [
      abortsRef,
      forgetDraft,
      setActiveId,
      setFailures,
      setQueues,
      setRuns,
      setSessions,
      setThreads,
    ]
  )

  const handleNewChat = React.useCallback(async () => {
    closeNav()
    closePreview()
    const empty = sessions.find(
      (session) =>
        session.messageCount === 0 &&
        (threadsRef.current[session.id]?.length ?? 0) === 0
    )
    if (empty) {
      selectSession(empty.id)
      return
    }
    try {
      const created = await api.createSession({
        providerId,
        model,
        permissionMode: chosenPermission || undefined,
      })
      setSessions((prev) => [created, ...prev])
      setThreads((prev) => ({ ...prev, [created.id]: [] }))
      if (openThreadLength > 0) {
        runLayoutTransition(() => setActiveId(created.id))
      } else {
        setActiveId(created.id)
      }
    } catch (err) {
      toast.error(errorMessage(err, "Could not start a new chat"))
    }
  }, [
    chosenPermission,
    closeNav,
    closePreview,
    model,
    openThreadLength,
    providerId,
    selectSession,
    sessions,
    setActiveId,
    setSessions,
    setThreads,
    threadsRef,
  ])

  /**
   * Opens the chat's folder in the editor, the file manager or a terminal.
   * Reads state, not the refs: it is handed to the command palette's memoized
   * action list, which is built during render.
   */
  const openFolder = React.useCallback(
    (action: "editor" | "reveal" | "terminal") => {
      if (!activeId || !activeFolder) {
        toast.message("This chat has no working folder yet")
        return
      }
      void api
        .openPath({ action, path: activeFolder, sessionId: activeId })
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not open the folder"))
        )
    },
    [activeFolder, activeId]
  )

  return {
    selectSession,
    openFolder,
    setFolder,
    removeSession,
    removeSessions,
    handleNewChat,
  }
}
