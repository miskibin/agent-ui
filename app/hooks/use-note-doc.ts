"use client"

import * as React from "react"
import { toast } from "sonner"

import {
  fetchNote,
  fetchNoteThreads,
  saveNote,
  watchNote,
} from "@/lib/notes/client"
import type { NoteMeta, NoteThread } from "@/lib/notes/types"

type PendingSave = { content: string; base: string }

/**
 * One open note, kept in step with the other writer.
 *
 * The protocol is three rules, and the editor (`NoteEditor`) keeps the other
 * half of it:
 *
 * 1. Every save carries its *base* — the content the editor's text grew from
 *    — and the server merges against it when the note moved on meanwhile.
 * 2. Saves go out one at a time; the ones that queue behind a save in flight
 *    collapse into one, keeping the oldest base, because the newest text
 *    descends from it.
 * 3. A value is handed back to the editor only when it descends from the
 *    editor's latest change: a save's answer when nothing newer is waiting,
 *    or a fetched revision when nothing is waiting at all. Anything else is
 *    left to the next save, which merges it on the server.
 */
export function useNoteDoc(noteId: string, onTitle?: (meta: NoteMeta) => void) {
  const [meta, setMeta] = React.useState<NoteMeta | null>(null)
  const [value, setValue] = React.useState<string | null>(null)
  const [threads, setThreads] = React.useState<NoteThread[]>([])
  const [activeThread, setActiveThread] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [saveState, setSaveState] = React.useState<"saved" | "saving" | "error">("saved")

  /** What the editor's next change descends from. */
  const agreed = React.useRef("")
  const appliedRev = React.useRef(0)
  /** The newest rev an event announced; a fetch is owed while it is ahead. */
  const announcedRev = React.useRef(0)
  const queue = React.useRef<PendingSave | null>(null)
  const inFlight = React.useRef(false)
  const onTitleRef = React.useRef(onTitle)
  React.useEffect(() => {
    onTitleRef.current = onTitle
  }, [onTitle])

  const metaRef = React.useRef<NoteMeta | null>(null)
  const takeMeta = React.useCallback((next: NoteMeta) => {
    const prev = metaRef.current
    metaRef.current = next
    setMeta(next)
    if (prev && (prev.title !== next.title || prev.updatedAt !== next.updatedAt)) onTitleRef.current?.(next)
  }, [])

  const refresh = React.useCallback(async () => {
    if (inFlight.current || queue.current) return
    try {
      const snapshot = await fetchNote(noteId)
      if (inFlight.current || queue.current) return
      takeMeta(snapshot.meta)
      setThreads(snapshot.threads)
      setActiveThread(snapshot.activeThread)
      if (snapshot.meta.rev > appliedRev.current) {
        appliedRev.current = snapshot.meta.rev
        agreed.current = snapshot.content
        setValue(snapshot.content)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [noteId, takeMeta])

  const pump = React.useCallback(async () => {
    if (inFlight.current || !queue.current) return
    const next = queue.current
    queue.current = null
    inFlight.current = true
    setSaveState("saving")
    let failed = false
    try {
      const saved = await saveNote(noteId, {
        content: next.content,
        base: next.base,
        baseRev: appliedRev.current,
      })
      appliedRev.current = Math.max(appliedRev.current, saved.meta.rev)
      takeMeta(saved.meta)
      if (!queue.current && saved.content !== next.content) {
        agreed.current = saved.content
        setValue(saved.content)
      }
    } catch (err) {
      failed = true
      // Put it back in front of anything newer, which descends from it.
      const waiting = queue.current as PendingSave | null
      queue.current = waiting ? { content: waiting.content, base: next.base } : next
      toast.error(err instanceof Error ? err.message : "Could not save the note")
    } finally {
      inFlight.current = false
      if (failed) {
        setSaveState("error")
        setTimeout(() => void pumpRef.current(), 3000)
      } else if (queue.current) {
        void pumpRef.current()
      } else {
        setSaveState("saved")
        if (announcedRev.current > appliedRev.current) void refresh()
      }
    }
  }, [noteId, refresh, takeMeta])

  const pumpRef = React.useRef(pump)
  React.useEffect(() => {
    pumpRef.current = pump
  }, [pump])

  const onChange = React.useCallback((markdown: string) => {
    queue.current = queue.current
      ? { content: markdown, base: queue.current.base }
      : { content: markdown, base: agreed.current }
    agreed.current = markdown
    setValue(markdown)
    void pumpRef.current()
  }, [])

  const refreshThreads = React.useCallback(async () => {
    try {
      const next = await fetchNoteThreads(noteId)
      setThreads(next.threads)
      setActiveThread(next.activeThread)
    } catch {
      /* the next event retries */
    }
  }, [noteId])

  React.useEffect(() => {
    const abort = new AbortController()
    fetchNote(noteId, abort.signal)
      .then((snapshot) => {
        appliedRev.current = snapshot.meta.rev
        agreed.current = snapshot.content
        metaRef.current = snapshot.meta
        setMeta(snapshot.meta)
        setValue(snapshot.content)
        setThreads(snapshot.threads)
        setActiveThread(snapshot.activeThread)
      })
      .catch((err: unknown) => {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      })
    const stop = watchNote(noteId, (event) => {
      if (event.type === "threads") void refreshThreads()
      else if (event.rev > appliedRev.current) {
        announcedRev.current = Math.max(announcedRev.current, event.rev)
        void refresh()
      }
    })
    return () => {
      abort.abort()
      stop()
    }
  }, [noteId, refresh, refreshThreads])

  return { meta, value, threads, activeThread, error, saveState, onChange, refreshThreads }
}
