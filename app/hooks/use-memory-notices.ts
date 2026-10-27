"use client"

import * as React from "react"
import { toast } from "sonner"

import * as api from "@/lib/api-client"
import { omit } from "@/lib/chat-helpers"
import type { MemoryChange } from "@/lib/memory/types"

import type { ChatRefs } from "./use-chat-refs"

/**
 * The user-memory update that runs after a turn settles, the marker it leaves
 * in the thread, and the boot check that says when memory cannot run at all.
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
    Record<string, { changes: MemoryChange[] }>
  >({})
  /** Chats with an extraction pass in flight, so a fast reply cannot start two. */
  const memoryRunsRef = React.useRef(new Set<string>())

  /**
   * Memory's Ollama is down and could not be started. Set by the boot check,
   * or by an update that found it gone; cleared by the next one that works.
   * `memoryOutage` is the dialog; the ref is what keeps the per-turn update
   * quiet meanwhile — the outage was said once, and a loading toast that
   * ends in an error after every answer is the ugliness this replaces.
   */
  const [memoryOutage, setMemoryOutage] = React.useState<{
    baseUrl: string
    retrying: boolean
    stillDown: boolean
  } | null>(null)
  const memoryDownRef = React.useRef(false)
  /** The dialog is shown once per page load, however many turns find Ollama gone. */
  const outageShownRef = React.useRef(false)

  const reportOutage = React.useCallback((baseUrl: string) => {
    memoryDownRef.current = true
    if (outageShownRef.current) return
    outageShownRef.current = true
    setMemoryOutage({ baseUrl, retrying: false, stillDown: false })
  }, [])

  /**
   * Asked once per page load. The server tries to start Ollama before it
   * answers, and starts the embedding model's download when it is missing —
   * so opening the app is the whole setup, and the dialog only appears when
   * both the probe and the start failed.
   */
  React.useEffect(() => {
    let cancelled = false
    api
      .fetchMemoryStatus()
      .then((status) => {
        if (cancelled || !status.enabled) return
        if (!status.reachable) reportOutage(status.baseUrl)
        else if (status.embed === "pulling") {
          toast.message(`Downloading ${status.embedModel} for memory…`, {
            description: "Until it lands, facts are matched by shared words.",
          })
        }
      })
      .catch(() => {
        /* the check is advisory; a turn finds out on its own */
      })
    return () => {
      cancelled = true
    }
  }, [reportOutage])

  const retryMemory = React.useCallback(() => {
    setMemoryOutage((current) => current && { ...current, retrying: true })
    void api
      .fetchMemoryStatus(true)
      .then((status) => {
        if (status.reachable) {
          memoryDownRef.current = false
          setMemoryOutage(null)
          toast.success("Ollama is running — memory is back on.")
        } else {
          setMemoryOutage((current) =>
            current && { ...current, retrying: false, stillDown: true }
          )
        }
      })
      .catch(() => {
        setMemoryOutage((current) =>
          current && { ...current, retrying: false, stillDown: true }
        )
      })
  }, [])

  const dismissMemoryOutage = React.useCallback(() => setMemoryOutage(null), [])

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
      // While Ollama is known to be down the run still goes out — it is how
      // memory notices Ollama came back — but without a toast to fail.
      const quiet = memoryDownRef.current
      if (!quiet) toast.loading("Updating memory…", at)
      try {
        const result = await api.updateMemory(sessionId)
        if (result.skipped === "unreachable") {
          toast.dismiss(toastId)
          reportOutage(settingsRef.current?.providers.ollama.baseUrl ?? "")
          return
        }
        memoryDownRef.current = false
        if (result.changes.length > 0) {
          setMemoryNotices((prev) => ({
            ...prev,
            [sessionId]: { changes: result.changes },
          }))
          toast.dismiss(toastId)
        } else if (result.skipped === "failed") {
          if (quiet) return
          toast.error("Couldn't update memory.", at)
        } else {
          // Nothing durable was said. That is the common case, and it is not
          // worth a line of UI.
          toast.dismiss(toastId)
        }
      } catch {
        if (quiet) toast.dismiss(toastId)
        else toast.error("Couldn't update memory.", at)
      } finally {
        memoryRunsRef.current.delete(sessionId)
      }
    },
    [settingsRef, reportOutage]
  )

  const dismissMemoryNotice = React.useCallback((sessionId: string) => {
    setMemoryNotices((prev) => omit(prev, sessionId))
  }, [])

  return {
    memoryNotices,
    setMemoryNotices,
    runMemoryUpdate,
    dismissMemoryNotice,
    memoryOutage,
    retryMemory,
    dismissMemoryOutage,
  }
}
