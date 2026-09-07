"use client"

import * as React from "react"
import { toast } from "sonner"

import type { FolderSelection } from "@/components/folder-picker"
import * as api from "@/lib/api-client"
import { completeAsk, findPendingAsk } from "@/lib/ask-tools"
import { errorMessage, omit } from "@/lib/chat-helpers"
import { clearDraft } from "@/lib/drafts"
import { folderName } from "@/lib/folder"
import { runLayoutTransition } from "@/lib/layout-transition"
import type { PermissionMode, ProviderInfo } from "@/lib/providers/types"
import {
  autoSettle,
  autoSettleAfterDays,
  wokeAt,
} from "@/lib/session-lifecycle"
import { snoozeWakeDescription } from "@/lib/snooze"
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
    settingsRef,
    threadsRef,
  } = refs

  /**
   * Set below. `selectSession` is defined first and marks the chat it opens
   * as seen, which is the one call that has to reach forward.
   */
  const markVisitedRef = React.useRef<(id: string) => void>(() => {})

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
      // Opening a chat is the other way to say "seen" — it clears the wake
      // notice the same way pressing the pill does.
      markVisitedRef.current(id)
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
   * The chat's working folder — the whole `FolderSelection`, which is why the
   * parameter is not just a path: a folder the picker created a worktree for
   * arrives with its provenance (`SessionMeta.worktree`) attached, and that is
   * what the sidebar's header and the delete path's cleanup offer read.
   *
   * A chat that does not exist yet (the very first one, before anything is
   * sent) is created with the folder already on it, so picking one is never
   * lost.
   */
  const setFolder = React.useCallback(
    (next: FolderSelection) => {
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

  /* ------------------------------------------------------------------ */
  /* Lifecycle: settle, snooze, wake, visit                                */
  /* ------------------------------------------------------------------ */

  /**
   * An unanswered question is dismissed when the chat is filed away.
   *
   * Settling says the work is done, and a question waiting for an answer in a
   * chat nobody will look at again is a turn the model is still notionally
   * blocked on. The same treatment `send` gives an ask the user typed past —
   * marked skipped, in the transcript, where it stays visible.
   */
  const dismissAsk = React.useCallback(
    (id: string) => {
      const thread = threadsRef.current[id]
      if (!thread) return
      const pending = findPendingAsk(thread)
      if (!pending) return
      const next = completeAsk(thread, pending.messageId, pending.toolId, {
        skipped: true,
        answers: {},
      })
      setThreads((prev) => ({ ...prev, [id]: next }))
      void api.putMessages(id, next).catch(() => {
        /* cosmetic: the block is already closed in the open transcript */
      })
    },
    [setThreads, threadsRef]
  )

  /**
   * File a chat away, or take it back out.
   *
   * Both directions write `settledOverride`, because both are the user
   * overruling the age rule — the second one has to *keep* overruling it, or
   * the next sweep would file the chat straight back. `0` is how the wire
   * clears a timestamp (see `lib/store/sessions`), while the local mirror
   * simply drops the field.
   */
  const settleChat = React.useCallback(
    (id: string, settled: boolean) => {
      const now = Date.now()
      patchLocal(
        id,
        settled
          ? {
              settledAt: now,
              settledOverride: "settled",
              // Settling outranks a snooze, and the chat is not coming back.
              snoozedUntil: undefined,
              snoozedAt: undefined,
              wokeAt: undefined,
            }
          : { settledAt: undefined, settledOverride: "active" }
      )
      void api
        .patchSession(
          id,
          settled
            ? {
                settledAt: now,
                settledOverride: "settled",
                snoozedUntil: 0,
                snoozedAt: 0,
                wokeAt: 0,
              }
            : { settledAt: 0, settledOverride: "active" }
        )
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not update the chat"))
        )
      if (settled) dismissAsk(id)
    },
    [dismissAsk, patchLocal]
  )

  /** Bring a snoozed chat back now. The user did it, so there is no news to announce. */
  const wakeChat = React.useCallback(
    (id: string) => {
      const now = Date.now()
      patchLocal(id, {
        snoozedUntil: undefined,
        snoozedAt: undefined,
        wokeAt: undefined,
        lastVisitedAt: now,
      })
      void api
        .patchSession(id, {
          snoozedUntil: 0,
          snoozedAt: 0,
          wokeAt: 0,
          lastVisitedAt: now,
        })
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not wake the chat"))
        )
    },
    [patchLocal]
  )

  /**
   * Put a chat down until `until`. Nothing schedules the return — the wake
   * time simply stops classifying as snoozed once it has passed, which is
   * what makes a snooze survive a reload, a restart and a closed laptop.
   */
  const snoozeChat = React.useCallback(
    (id: string, until: number) => {
      const now = Date.now()
      if (!Number.isFinite(until) || until <= now) return
      patchLocal(id, { snoozedUntil: until, snoozedAt: now, wokeAt: undefined })
      void api
        .patchSession(id, { snoozedUntil: until, snoozedAt: now, wokeAt: 0 })
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not snooze the chat"))
        )
      toast.message(`Snoozed until ${snoozeWakeDescription(until, now)}`, {
        action: { label: "Undo", onClick: () => wakeChat(id) },
      })
    },
    [patchLocal, wakeChat]
  )

  /**
   * "Seen" — pressing the Woke pill, or simply opening the chat.
   *
   * A no-op unless there is actually a wake notice to clear, because this
   * runs on every chat you open and the index is the app's hottest file.
   */
  const markVisited = React.useCallback(
    (id: string) => {
      const session = sessionsRef.current.find((entry) => entry.id === id)
      if (!session || wokeAt(session, Date.now()) === null) return
      const now = Date.now()
      patchLocal(id, { lastVisitedAt: now })
      void api.patchSession(id, { lastVisitedAt: now }).catch(() => {
        /* a wake notice that outlives one reload is not worth a toast */
      })
    },
    [patchLocal, sessionsRef]
  )
  React.useEffect(() => {
    markVisitedRef.current = markVisited
  }, [markVisited])

  /**
   * The age rule, evaluated on read.
   *
   * There is no scheduler behind settling: a chat that has been silent long
   * enough is settled the next time anyone looks, which is when the app opens
   * and when the window comes back to the front. That is also why the sweep
   * is cheap — it reads the index it already has, and writes only the rows
   * that actually move.
   */
  const sweepSettled = React.useCallback(
    (list: SessionMeta[]) => {
      const chat = settingsRef.current?.chat as
        | Record<string, unknown>
        | undefined
      const days = autoSettleAfterDays(chat?.autoSettleAfterDays)
      // `null` is the user turning the rule off.
      if (days === null) return
      const now = Date.now()
      for (const session of list) {
        const stale = autoSettle(session, now, {
          afterDays: days,
          running: abortsRef.current.has(session.id),
          awaiting:
            findPendingAsk(threadsRef.current[session.id] ?? []) !== null,
        })
        if (!stale) continue
        // No override: this is the rule's doing, and the user can still
        // overrule it in either direction afterwards.
        patchLocal(session.id, { settledAt: now })
        void api.patchSession(session.id, { settledAt: now }).catch(() => {
          /* the next sweep tries again */
        })
      }
    },
    [abortsRef, patchLocal, settingsRef, threadsRef]
  )

  const sweptRef = React.useRef(false)
  React.useEffect(() => {
    if (sweptRef.current || sessions.length === 0) return
    sweptRef.current = true
    // After paint: the settings mirror this reads is written by `useMirrorRefs`.
    queueMicrotask(() => sweepSettled(sessions))
  }, [sessions, sweepSettled])

  React.useEffect(() => {
    const onFocus = () => sweepSettled(sessionsRef.current)
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [sessionsRef, sweepSettled])

  /**
   * The worktree a chat was working in, when it was working in one of its own.
   *
   * `worktree.root` is the recorded answer; `cwd` is the fallback, because a
   * chat started before that field existed still has its folder — and the
   * server is the one that decides whether a folder is a worktree the app
   * made, so guessing here would be wrong either way.
   */
  const worktreeRootOf = React.useCallback((session: SessionMeta | undefined) => {
    return session?.worktree?.root.trim() || session?.cwd?.trim() || ""
  }, [])

  /**
   * Deleting the last chat that used a worktree offers to delete the worktree
   * too — the folder and the branch both, since nothing else is holding them.
   *
   * It is an offer, not a consequence: an agent's work is on that branch, and
   * "I deleted the chat" is not "I meant to throw away the code". So the toast
   * says what would be lost (uncommitted files, commits that were never
   * pushed) and does nothing until the user presses the action. The server
   * decides whether the folder is a worktree at all — see
   * `GET /api/worktrees/status`.
   */
  const offerWorktreeCleanup = React.useCallback(
    (removed: (SessionMeta | undefined)[], remaining: SessionMeta[]) => {
      const stillUsed = new Set(
        remaining.map(worktreeRootOf).filter((root) => root.length > 0)
      )
      const orphans = new Map<string, SessionMeta>()
      for (const session of removed) {
        const root = worktreeRootOf(session)
        // A worktree two chats share is not orphaned by losing one of them.
        if (!session || !root || stillUsed.has(root) || orphans.has(root)) continue
        orphans.set(root, session)
      }
      for (const [root, session] of orphans) {
        void api
          .fetchWorktreeCleanup(root)
          .then((info) => {
            if (!info.managed) return
            const branch = info.branch || session.worktree?.branch || ""
            const at = [folderName(info.root), branch].filter(Boolean).join(" · ")
            const losses = [
              info.status.dirty > 0 &&
                `${info.status.dirty} uncommitted file${info.status.dirty === 1 ? "" : "s"}`,
              info.status.unpushed > 0 &&
                `${info.status.unpushed} unpushed commit${info.status.unpushed === 1 ? "" : "s"}`,
            ].filter((part): part is string => typeof part === "string")
            toast("Remove worktree and branch?", {
              description: losses.length
                ? `${at} still has ${losses.join(" and ")}.`
                : at,
              duration: 15_000,
              action: {
                label: "Remove",
                onClick: () => {
                  void api
                    .removeWorktree({
                      repoRoot: info.repoRoot,
                      root: info.root,
                      branch: branch || undefined,
                      // The warning above is the confirmation: without this a
                      // worktree with uncommitted work refuses to go, and the
                      // user has just said to remove it anyway.
                      force: true,
                    })
                    .then((result) => {
                      toast.success(
                        result.branchDeleted && branch
                          ? `Removed the worktree and ${branch}`
                          : "Removed the worktree"
                      )
                    })
                    .catch((err: unknown) =>
                      toast.error(
                        errorMessage(err, "Could not remove the worktree")
                      )
                    )
                },
              },
            })
          })
          .catch(() => {
            /* the chat is already gone; a failed probe offers nothing */
          })
      }
    },
    [worktreeRootOf]
  )

  const removeSession = React.useCallback(
    (id: string) => {
      const known = sessionsRef.current
      const removed = known.find((session) => session.id === id)
      const remaining = known.filter((session) => session.id !== id)
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
        .then(() => offerWorktreeCleanup([removed], remaining))
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not delete the chat"))
        )
    },
    [
      abortsRef,
      activeIdRef,
      closePreview,
      forgetDraft,
      offerWorktreeCleanup,
      sessionsRef,
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
      const known = sessionsRef.current
      const removed = known.filter((session) => idSet.has(session.id))
      const remaining = known.filter((session) => !idSet.has(session.id))
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
      void Promise.all(
        ids.map((id) =>
          api
            .deleteSession(id)
            .catch((err: unknown) =>
              toast.error(errorMessage(err, "Could not delete the chat"))
            )
        )
      ).then(() => offerWorktreeCleanup(removed, remaining))
      toast.message(
        ids.length === 1 ? "Chat deleted" : `${ids.length} chats deleted`
      )
    },
    [
      abortsRef,
      forgetDraft,
      offerWorktreeCleanup,
      sessionsRef,
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
    settleChat,
    snoozeChat,
    wakeChat,
    markVisited,
    removeSession,
    removeSessions,
    handleNewChat,
  }
}
