"use client"

import * as React from "react"

import type { useDraftStore } from "@/components/context-usage"
import type {
  ChatInputDraft,
  ChatInputMentionItem,
} from "@/components/ui/chat-input"
import * as api from "@/lib/api-client"
import { createDraftWriter, readDrafts } from "@/lib/drafts"

import { EMPTY_MENTIONS } from "./chat-types"
import type { ChatRefs } from "./use-chat-refs"

/** How long the composer waits after a keystroke before saving the draft. */
const DRAFT_SAVE_MS = 300

/**
 * The composer follows the chat. Each chat's half-written prompt is parked in
 * memory on the way out — files included, which localStorage could not hold —
 * and its text is written to localStorage a beat after the last keystroke, so
 * a reload still finds it.
 *
 * `@` mentions and "Quote" live here too: both write into the composer through
 * its handle rather than through state, which is what keeps the memoized
 * composer out of the streaming render path.
 */
export function useComposerDrafts({
  refs,
  activeId,
  draftStore,
}: {
  refs: ChatRefs
  activeId: string
  draftStore: ReturnType<typeof useDraftStore>
}) {
  const { activeIdRef, composerRef, sessionsRef } = refs
  /** Each chat's composer state while it is not the open one (files included). */
  const draftsRef = React.useRef(new Map<string, ChatInputDraft>())
  const writerRef = React.useRef(createDraftWriter(DRAFT_SAVE_MS))
  /** Chats deleted while open — the effect below must not park them again. */
  const forgottenRef = React.useRef(new Set<string>())

  React.useEffect(() => {
    const composer = composerRef.current
    if (!composer) return
    const id = activeId
    const drafts = draftsRef.current
    const forgotten = forgottenRef.current
    const writer = writerRef.current
    const parked = drafts.get(id)
    composer.setDraft(
      parked ?? {
        text: id ? (readDrafts()[id] ?? "") : "",
        files: [],
        skills: [],
      }
    )
    return () => {
      // Leaving this chat: its half-written text goes to localStorage now,
      // because `setDraft` above is about to hand `onTextChange` the next
      // chat's text and re-arm the timer.
      writer.flush()
      // A chat deleted while it was the open one is gone from the map on
      // purpose; parking it here would put it back, File objects and all.
      if (forgotten.delete(id)) return
      drafts.set(id, composer.getDraft())
    }
  }, [activeId, composerRef])

  /** The draft feeds the context meter now and localStorage a beat later. */
  const handleTextChange = React.useCallback(
    (text: string) => {
      draftStore.set(text)
      writerRef.current.schedule(activeIdRef.current, text)
    },
    [activeIdRef, draftStore]
  )

  /**
   * A deleted chat's draft, dropped everywhere it is held: the parked copy,
   * the write still on the timer, and the park the switch effect would
   * otherwise make on its way out.
   */
  const forgetDraft = React.useCallback(
    (id: string) => {
      draftsRef.current.delete(id)
      writerRef.current.forget(id)
      if (id && id === activeIdRef.current) forgottenRef.current.add(id)
    },
    [activeIdRef]
  )

  /** `@` in the composer → files under the chat's folder. */
  const handleMentions = React.useCallback(
    async (query: string) => {
      const session = sessionsRef.current.find(
        (item) => item.id === activeIdRef.current
      )
      if (!session?.cwd) return EMPTY_MENTIONS
      try {
        const { files } = await api.searchFiles(session.id, query)
        return files.map<ChatInputMentionItem>((file) => ({
          id: file,
          label: file,
          insert: `@${file}`,
        }))
      } catch {
        return EMPTY_MENTIONS
      }
    },
    [activeIdRef, sessionsRef]
  )

  /** "Quote" over a selection in an answer → a blockquote in the composer. */
  const handleQuote = React.useCallback(
    (_messageId: string, text: string) => {
      const quoted = text
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
      composerRef.current?.insertText(`${quoted}\n\n`)
      composerRef.current?.focus()
    },
    [composerRef]
  )

  return { forgetDraft, handleTextChange, handleMentions, handleQuote }
}
