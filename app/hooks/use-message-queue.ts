"use client"

import * as React from "react"
import { toast } from "sonner"

import type { ChatInputPayload } from "@/components/ui/chat-input"
import { omit } from "@/lib/chat-helpers"
import { newId } from "@/lib/message-stream"
import { parseSlashCommand } from "@/lib/slash-commands"

import { EMPTY_QUEUE, type QueuedMessage } from "./chat-types"
import type { ChatRefs } from "./use-chat-refs"

export type MessageQueue = ReturnType<typeof useMessageQueue>

/**
 * Messages typed while a turn is streaming, per chat, sent one at a time as
 * turns end. A stopped turn keeps its queue — Stop usually means "let me
 * rephrase", not "forget what I lined up".
 *
 * `send` is wired in through `drainQueueRef` rather than passed: the turn
 * runner is defined before `send` exists, and it is the runner's `finally`
 * that drains the queue.
 */
export function useMessageQueue({
  refs,
  activeId,
  parkDraft,
}: {
  refs: ChatRefs
  activeId: string
  parkDraft: () => void
}) {
  const { activeIdRef, composerRef, queuesRef } = refs
  const [queues, setQueues] = React.useState<Record<string, QueuedMessage[]>>(
    {}
  )

  const handleQueue = React.useCallback(
    (payload: ChatInputPayload) => {
      const sessionId = activeIdRef.current
      if (!sessionId) return
      // The app's own commands act on the chat now, not on a model later — and
      // a queued one could drain into another chat's turn. Hand it back.
      if (parseSlashCommand(payload.text)) {
        composerRef.current?.setDraft(payload)
        toast.message("Commands run right away — send it once the turn ends")
        return
      }
      const item: QueuedMessage = {
        id: newId(),
        text: payload.text,
        files: payload.files,
        skills: payload.skills,
        fileCount: payload.files.length || undefined,
      }
      setQueues((prev) => ({
        ...prev,
        [sessionId]: [...(prev[sessionId] ?? []), item],
      }))
    },
    [activeIdRef, composerRef]
  )

  const takeQueued = React.useCallback(
    (sessionId: string, id: string) => {
      const item = queuesRef.current[sessionId]?.find((entry) => entry.id === id)
      if (!item) return null
      setQueues((prev) => {
        const rest = (prev[sessionId] ?? []).filter((entry) => entry.id !== id)
        return rest.length > 0
          ? { ...prev, [sessionId]: rest }
          : omit(prev, sessionId)
      })
      return item
    },
    [queuesRef]
  )

  const handleQueueRemove = React.useCallback(
    (id: string) => {
      takeQueued(activeIdRef.current, id)
    },
    [activeIdRef, takeQueued]
  )

  const handleQueueEdit = React.useCallback(
    (id: string) => {
      const item = takeQueued(activeIdRef.current, id)
      if (!item) return
      parkDraft()
      composerRef.current?.setDraft({
        text: item.text,
        files: item.files,
        skills: item.skills,
      })
      composerRef.current?.focus()
    },
    [activeIdRef, composerRef, parkDraft, takeQueued]
  )

  const queueItems = queues[activeId] ?? EMPTY_QUEUE

  return {
    queues,
    setQueues,
    queueItems,
    handleQueue,
    takeQueued,
    handleQueueRemove,
    handleQueueEdit,
  }
}
