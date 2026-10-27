"use client"

import * as React from "react"
import { toast } from "sonner"

import * as api from "@/lib/api-client"
import { errorMessage } from "@/lib/chat-helpers"

/** While anything is listed (or the panel is open), how often it is re-read. */
const POLL_MS = 15_000

/**
 * What the open chat's agents left running (`lib/background-processes`), and
 * whether the side panel is showing it.
 *
 * Read when the chat is opened and whenever its turn ends — the request made
 * right after a turn waits on the server for that turn's survivors to be
 * counted, so a dev server the agent just started is in the first answer —
 * then polled only while there is something to watch: a process can exit on
 * its own, and the badge should not keep claiming it.
 */
export function useBackgroundProcesses({
  activeId,
  isGenerating,
}: {
  activeId: string
  isGenerating: boolean
}) {
  const [state, setState] = React.useState<{
    sessionId: string
    rows: api.BackgroundProcessRow[]
  } | null>(null)
  const [openFor, setOpenFor] = React.useState<string | null>(null)
  const rows = React.useMemo(
    () => (state && state.sessionId === activeId ? state.rows : []),
    [activeId, state]
  )
  const open = openFor !== null && openFor === activeId

  const controllerRef = React.useRef<AbortController | null>(null)
  const refresh = React.useCallback(() => {
    if (!activeId) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    void api
      .fetchBackgroundProcesses(activeId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setState({ sessionId: activeId, rows: next })
      })
      .catch(() => {
        /* an aid, not something to interrupt anyone over */
      })
  }, [activeId])

  // On open, and on every turn's end — `isGenerating` falling is the signal.
  React.useEffect(() => {
    if (isGenerating) return
    refresh()
    return () => controllerRef.current?.abort()
  }, [isGenerating, refresh])

  const watching = rows.length > 0 || open
  React.useEffect(() => {
    if (!watching) return
    const timer = setInterval(refresh, POLL_MS)
    window.addEventListener("focus", refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener("focus", refresh)
    }
  }, [refresh, watching])

  const stop = React.useCallback(
    (pid?: number) => {
      if (!activeId) return
      const sessionId = activeId
      // Gone from the list at once; the next read says whether it really went.
      setState((current) =>
        current && current.sessionId === sessionId
          ? {
              sessionId,
              rows: pid === undefined ? [] : current.rows.filter((row) => row.pid !== pid),
            }
          : current
      )
      void api
        .stopBackgroundProcesses(sessionId, pid)
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not stop the process"))
        )
        .finally(refresh)
    },
    [activeId, refresh]
  )

  const toggle = React.useCallback(() => {
    setOpenFor((current) => (current === activeId ? null : activeId))
  }, [activeId])
  const close = React.useCallback(() => setOpenFor(null), [])

  return { processes: rows, processesOpen: open, toggle, close, stop, refresh }
}
