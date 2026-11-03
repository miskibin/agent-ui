"use client"

import { FileText } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { RelativeTime } from "@/components/live-time"
import type { ChatSidebarItemData } from "@/components/ui/chat-sidebar"
import { createNote, deleteNote, fetchNotes } from "@/lib/notes/client"
import type { NoteMeta } from "@/lib/notes/types"

function byUpdated(a: NoteMeta, b: NoteMeta) {
  return b.updatedAt - a.updatedAt
}

/**
 * The notes the sidebar lists and the one open in the main pane. A note
 * opened here covers the chat rather than replacing it: the chat page owns
 * every in-flight turn, so nothing under it is unmounted (see `app/page.tsx`).
 */
export function useNotes() {
  const [notes, setNotes] = React.useState<NoteMeta[]>([])
  const [activeNoteId, setActiveNoteId] = React.useState<string | null>(null)

  React.useEffect(() => {
    let live = true
    fetchNotes()
      .then((list) => {
        if (live) setNotes(list)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const newNote = React.useCallback(() => {
    createNote("")
      .then((doc) => {
        setNotes((prev) => [doc.meta, ...prev])
        setActiveNoteId(doc.meta.id)
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Could not create a note"))
  }, [])

  const openNote = React.useCallback((id: string) => setActiveNoteId(id), [])
  const closeNote = React.useCallback(() => setActiveNoteId(null), [])

  const removeNote = React.useCallback((id: string) => {
    deleteNote(id)
      .then(() => {
        setNotes((prev) => prev.filter((note) => note.id !== id))
        setActiveNoteId((current) => (current === id ? null : current))
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Could not delete the note"))
  }, [])

  const updateNote = React.useCallback((meta: NoteMeta) => {
    setNotes((prev) => prev.map((note) => (note.id === meta.id ? meta : note)).sort(byUpdated))
  }, [])

  const noteItems = React.useMemo<ChatSidebarItemData[]>(
    () =>
      notes.map((note) => ({
        id: note.id,
        title: note.title,
        leading: <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />,
        meta: <RelativeTime from={note.updatedAt} />,
      })),
    [notes]
  )

  return { notes, noteItems, activeNoteId, newNote, openNote, closeNote, removeNote, updateNote }
}
