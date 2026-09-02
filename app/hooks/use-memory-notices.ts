"use client"

import * as React from "react"
import { toast } from "sonner"

import * as api from "@/lib/api-client"
import { omit } from "@/lib/chat-helpers"
import type { MemoryChange } from "@/lib/memory/types"

import type { ChatRefs } from "./use-chat-refs"

/**
 * The user-memory update that runs after a turn settles, and the marker it
 * leaves in the thread.
 *
 * Fire-and-forget on purpose: the answer is already delivered and persisted,
 * so this owns nothing the chat needs.
 */
export function useMemoryNotices(refs: ChatRefs) {
  const { settingsRef } = refs
  /**
   * The last memory update per chat, shown as a marker in the thread. Keyed by
   * session so switching chats mid-extraction cannot show one chat's changes
   * under another's last turn.
   */
  const [memoryNotices, setMemoryNotices] = React.useState<
    Record<string, { changes: MemoryChange[]; compacted?: boolean }>
  >({})
  /** Chats with an extraction pass in flight, so a fast reply cannot start two. */
  const memoryRunsRef = React.useRef(new Set<string>())

  /**
   * It reports itself in two places for two different reasons — a corner toast
   * while it runs, because a local model can take a few seconds and silence
   * would read as a hang, and a marker in the thread afterwards, because "a
   * file that goes into every future conversation just changed" deserves
   * something the user can scroll back to rather than something that fades.
   */
  const runMemoryUpdate = React.useCallback(
    async (sessionId: string) => {
      const memory = settingsRef.current?.memory
      if (!memory?.enabled || !memory.autoUpdate || !memory.model) return
      if (memoryRunsRef.current.has(sessionId)) return
      memoryRunsRef.current.add(sessionId)

      const toastId = `memory-${sessionId}`
      // No position override: this rides the app's own corner (the `Toaster`'s
      // `bottom-right`), where every other notification in the app appears.
      const at = { id: toastId } as const
      toast.loading("Updating memory…", at)
      try {
        const result = await api.updateMemory(sessionId)
        if (result.changes.length > 0) {
          setMemoryNotices((prev) => ({
            ...prev,
            [sessionId]: {
              changes: result.changes,
              compacted: result.compacted,
            },
          }))
          toast.dismiss(toastId)
        } else if (result.skipped === "unreachable") {
          toast.error("Memory: no Ollama server to extract with.", at)
        } else if (result.skipped === "failed") {
          toast.error("Couldn't update memory.", at)
        } else {
          // Nothing durable was said. That is the common case, and it is not
          // worth a line of UI.
          toast.dismiss(toastId)
        }
      } catch {
        toast.error("Couldn't update memory.", at)
      } finally {
        memoryRunsRef.current.delete(sessionId)
      }
    },
    [settingsRef]
  )

  const dismissMemoryNotice = React.useCallback((sessionId: string) => {
    setMemoryNotices((prev) => omit(prev, sessionId))
  }, [])

  return {
    memoryNotices,
    setMemoryNotices,
    runMemoryUpdate,
    dismissMemoryNotice,
  }
}
