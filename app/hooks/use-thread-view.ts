"use client"

import * as React from "react"

import { collectChatChanges } from "@/components/chat-changes"
import { chatCost, contextTurnUsage } from "@/components/context-usage"
import type { ModelOption } from "@/components/ui/model-picker"
import { findPendingAsk, isInternalMessage } from "@/lib/ask-tools"
import type { StoredMessage } from "@/lib/store/types"
import { latestTodos } from "@/lib/todo-plan"
import { turnFiles } from "@/lib/turn-files"

import type { SessionRun } from "./chat-types"

/**
 * A turn's file card, cached against the stored message so it is built once
 * per turn rather than once per render. `turnFiles` answers undefined when it
 * has nothing to add, and the message object is then handed on untouched —
 * which is what keeps the memoized row from re-rendering.
 */
const turnFilesCache = new WeakMap<StoredMessage, StoredMessage>()

export function withTurnFiles(message: StoredMessage): StoredMessage {
  const cached = turnFilesCache.get(message)
  if (cached) return cached
  const changes = message.changes ?? turnFiles(message)
  const next = changes === message.changes ? message : { ...message, changes }
  turnFilesCache.set(message, next)
  return next
}

/**
 * Everything the conversation column derives from the open thread.
 *
 * The expensive scans run against a *deferred* copy of the transcript: a
 * streaming turn rewrites it every frame while a plan, a cost or a change card
 * moves a handful of times per run, so React is left to drop the intermediate
 * passes rather than the page paying for them.
 */
export function useThreadView({
  messages,
  threads,
  activeId,
  runs,
  models,
  model,
  isGenerating,
}: {
  /** The open chat's transcript — `threads[activeId]`, or the frozen empty. */
  messages: StoredMessage[]
  threads: Record<string, StoredMessage[]>
  activeId: string
  runs: Record<string, SessionRun>
  models: ModelOption[]
  model: string
  isGenerating: boolean
}) {
  /**
   * Ask Question answers are replayed to the model as a user turn, but the
   * tool row above already shows them — rendering the raw prompt as well is
   * duplicate noise. Keeps the same array when there is nothing to drop, so
   * the memoized rows never re-render for this.
   */
  const visibleMessages = React.useMemo(
    () =>
      messages.some(isInternalMessage)
        ? messages.filter((message) => !isInternalMessage(message))
        : messages,
    [messages]
  )

  /**
   * The plan bar above the composer. A streaming turn rewrites `messages` every
   * frame while the plan itself changes a handful of times per run, so the scan
   * runs against a deferred copy — React drops the intermediate ones.
   */
  const deferredMessages = React.useDeferredValue(messages)
  const todos = React.useMemo(
    () => latestTodos(deferredMessages),
    [deferredMessages]
  )

  /**
   * The composer's context ring. `base` is recomputed every render but only
   * *changes* when a turn reports its usage, so the memoized composer is not
   * rebuilt while one is streaming.
   */
  const contextTurn = contextTurnUsage(messages)
  const contextTotal = React.useMemo(
    () => models.find((option) => option.id === model)?.contextLength,
    [model, models]
  )
  const activeCost = React.useMemo(
    () => chatCost(deferredMessages),
    [deferredMessages]
  )

  /**
   * The transcript as the list sees it: same objects, except where a turn's
   * file card needs the media it produced folded in (`lib/turn-files`). The
   * live turn is left alone — its card is only rendered once it settles, so
   * rebuilding it per token would be pure waste.
   */
  const listMessages = React.useMemo(() => {
    const live = isGenerating ? visibleMessages.length - 1 : -1
    let patched = false
    const next = visibleMessages.map((message, index) => {
      const withFiles = index === live ? message : withTurnFiles(message)
      if (withFiles !== message) patched = true
      return withFiles
    })
    return patched ? next : visibleMessages
  }, [isGenerating, visibleMessages])

  const pendingAsk = React.useMemo(
    () => findPendingAsk(messages) !== null,
    [messages]
  )

  /**
   * Chats waiting on an answer, across every loaded thread — what the dock
   * badge counts. Only loaded threads can be checked; a chat that has never
   * been opened this session cannot be waiting on anything.
   */
  const waitingCount = React.useMemo(
    () =>
      Object.entries(threads).filter(
        ([id, thread]) =>
          id !== activeId && !runs[id] && findPendingAsk(thread) !== null
      ).length,
    [activeId, runs, threads]
  )

  /** Every file the chat changed, across its turns — the header's count. */
  const chatChanges = React.useMemo(
    () =>
      collectChatChanges(
        isGenerating ? deferredMessages.slice(0, -1) : deferredMessages
      ),
    [deferredMessages, isGenerating]
  )

  return {
    visibleMessages,
    listMessages,
    todos,
    contextTurn,
    contextTotal,
    activeCost,
    pendingAsk,
    waitingCount,
    chatChanges,
  }
}
