"use client"

import * as React from "react"
import { toast } from "sonner"

import type { ChatInputPayload } from "@/components/ui/chat-input"
import { nowMs } from "@/lib/chat-helpers"
import { readStash, writeStash, type StashEntry } from "@/lib/drafts"
import { newId } from "@/lib/message-stream"

import type { ChatRefs } from "./use-chat-refs"

/**
 * Prompts parked with ⌘S — global, not per chat, like a git stash.
 *
 * `parkDraft` is the other half of it: whenever something is about to
 * overwrite the composer (a queued message pulled back for editing, a stash
 * entry restored) whatever was typed goes here first, so nothing the user
 * wrote is lost to a click.
 */
export function usePromptStash(refs: ChatRefs) {
  const { composerRef } = refs
  const [stash, setStash] = React.useState<StashEntry[]>([])

  // Read back after mount — same microtask deferral as the sidebar seed.
  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      const entries = readStash()
      if (entries.length > 0) setStash(entries)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const parkDraft = React.useCallback(() => {
    const draft = composerRef.current?.getDraft()
    if (!draft || (!draft.text.trim() && draft.files.length === 0)) return
    const entry: StashEntry = {
      id: newId(),
      text: draft.text,
      createdAt: nowMs(),
      fileNames: draft.files.map((file) => file.name),
      files: draft.files,
      skills: draft.skills,
    }
    setStash((prev) => {
      const next = [entry, ...prev]
      writeStash(next)
      return next
    })
  }, [composerRef])

  const handleStash = React.useCallback((payload: ChatInputPayload) => {
    const entry: StashEntry = {
      id: newId(),
      text: payload.text,
      createdAt: nowMs(),
      fileNames: payload.files.map((file) => file.name),
      files: payload.files,
      skills: payload.skills,
    }
    setStash((prev) => {
      const next = [entry, ...prev]
      writeStash(next)
      return next
    })
    toast.message("Prompt stashed", {
      description: "Restore it from the stash button.",
    })
  }, [])

  const restoreStash = React.useCallback(
    (entry: StashEntry) => {
      parkDraft()
      composerRef.current?.setDraft({
        text: entry.text,
        files: entry.files ?? [],
        skills: entry.skills,
      })
      composerRef.current?.focus()
      setStash((prev) => {
        const next = prev.filter((item) => item.id !== entry.id)
        writeStash(next)
        return next
      })
    },
    [composerRef, parkDraft]
  )

  const discardStash = React.useCallback((id: string) => {
    setStash((prev) => {
      const next = prev.filter((item) => item.id !== id)
      writeStash(next)
      return next
    })
  }, [])

  return { stash, parkDraft, handleStash, restoreStash, discardStash }
}
