"use client"

import {
  Download,
  ExternalLink,
  FolderOpen,
  Sparkles,
  SquareTerminal,
} from "lucide-react"
import * as React from "react"

import type {
  CommandPaletteAction,
  CommandPaletteSession,
} from "@/components/command-palette"
import { searchChatMessages } from "@/lib/api-client"
import { isInternalMessage } from "@/lib/ask-tools"
import {
  MIN_SEARCH_QUERY,
  type MessageSearchHit,
} from "@/lib/message-search"
import type { SessionMeta } from "@/lib/store/types"

import type { ChatRefs } from "./use-chat-refs"
import type { LoadThread } from "./use-threads"

/** What ⌘K offers: every chat, plus the actions that apply to the open one. */
export function useCommandPalette({
  sessions,
  activeId,
  activeCwd,
  providerName,
  regenerateTitle,
  openFolder,
  openImport,
}: {
  sessions: SessionMeta[]
  activeId: string
  activeCwd: string | undefined
  providerName: (id: string) => string
  regenerateTitle: (id: string) => void
  openFolder: (action: "editor" | "reveal" | "terminal") => void
  /** Opens the import dialog — the one action that needs no open chat. */
  openImport: () => void
}) {
  const paletteActions = React.useMemo<CommandPaletteAction[]>(() => {
    /* Listed first and always: bringing a CLI's history over is what someone
       with an empty sidebar is looking for, and there is no chat to do it in. */
    const actions: CommandPaletteAction[] = [
      {
        id: "import",
        label: "Import history from Claude Code or Codex",
        icon: <Download />,
        onSelect: openImport,
      },
    ]
    if (!activeId) return actions
    actions.push({
      id: "title",
      label: "Regenerate chat title",
      icon: <Sparkles />,
      onSelect: () => regenerateTitle(activeId),
    })
    if (activeCwd) {
      actions.push(
        {
          id: "open-folder",
          label: "Open folder in editor",
          icon: <ExternalLink />,
          shortcut: "⌘O",
          onSelect: () => openFolder("editor"),
        },
        {
          id: "reveal-folder",
          label: "Reveal folder",
          icon: <FolderOpen />,
          onSelect: () => openFolder("reveal"),
        },
        {
          id: "terminal-folder",
          label: "Open terminal in folder",
          icon: <SquareTerminal />,
          onSelect: () => openFolder("terminal"),
        }
      )
    }
    return actions
  }, [activeCwd, activeId, openFolder, openImport, regenerateTitle])

  const paletteSessions = React.useMemo<CommandPaletteSession[]>(
    () =>
      sessions.map((session) => ({
        id: session.id,
        title: session.title || "Untitled",
        meta: [providerName(session.providerId), session.model]
          .filter(Boolean)
          .join(" · "),
      })),
    [providerName, sessions]
  )

  return { paletteActions, paletteSessions }
}

/**
 * How long the palette waits before asking. A keystroke is not a search: the
 * route walks stored transcripts, and firing one per character would have it
 * reading the store four times to answer the query typed last.
 */
const SEARCH_DEBOUNCE_MS = 150

export type MessageSearchState = {
  matches: MessageSearchHit[]
  hasMore: boolean
  /** A query is typed and its answer has not arrived — for the "Searching…" row. */
  pending: boolean
}

const EMPTY_SEARCH: MessageSearchState = {
  matches: [],
  hasMore: false,
  pending: false,
}

/**
 * The Messages group behind the palette's query — debounced, abortable, and
 * strictly additive: it is asked for only once the palette is open and two
 * characters are typed, so the chat page's first paint and the sidebar's
 * localStorage seed never wait on it.
 *
 * The last answer is kept beside the query it answered rather than cleared on
 * each keystroke, and what to render is *derived* from whether the two still
 * agree. That is what keeps the previous result on screen while the next one
 * is in flight (no flicker between characters) and makes a late answer to an
 * abandoned query unrenderable rather than merely unlikely — and it means the
 * effect never sets state synchronously in its own body.
 */
export function useMessageSearch(
  query: string,
  { enabled = true, limit }: { enabled?: boolean; limit?: number } = {}
): MessageSearchState {
  const trimmed = query.trim()
  const active = enabled && trimmed.length >= MIN_SEARCH_QUERY
  const [answer, setAnswer] = React.useState<{
    query: string
    matches: MessageSearchHit[]
    hasMore: boolean
  } | null>(null)

  React.useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchChatMessages(trimmed, {
        ...(limit ? { limit } : null),
        signal: controller.signal,
      })
        .then((result) => {
          if (controller.signal.aborted) return
          setAnswer({
            query: trimmed,
            matches: result.matches,
            hasMore: result.hasMore,
          })
        })
        // A failed search is not worth a toast: the palette still lists every
        // chat by title, and the group simply does not appear.
        .catch(() => {
          if (!controller.signal.aborted) setAnswer({ query: trimmed, matches: [], hasMore: false })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [active, limit, trimmed])

  if (!active) return EMPTY_SEARCH
  if (answer?.query !== trimmed) return { ...EMPTY_SEARCH, pending: true }
  return { matches: answer.matches, hasMore: answer.hasMore, pending: false }
}

/* -------------------------------------------------------------------------- */
/* Jumping to a message                                                        */
/* -------------------------------------------------------------------------- */

/** How long the row stays marked after the jump. */
const FLASH_MS = 1_600
/** Frames the reveal waits for its row before giving up (~2s at 60fps). */
const MAX_REVEAL_FRAMES = 120
/**
 * Written straight onto the row's DOM node. `MessageList` renders that element
 * without a `className` of its own, so React never reconciles the attribute
 * and this cannot fight it — which is the whole reason the mark is applied
 * here rather than threaded down as a prop that every memoized row would have
 * to re-render for.
 */
const FLASH_CLASSES = ["rounded-lg", "ring-2", "ring-ring/60"]

/**
 * The nth rendered turn, but only once the list holds exactly the transcript
 * we are jumping into: a chat switch leaves the previous conversation's rows
 * mounted for a frame, and scrolling to the nth of *those* lands on a message
 * nobody searched for.
 */
function messageRow(index: number, expected: number): HTMLElement | null {
  const rows = document.querySelectorAll<HTMLElement>(
    '[data-slot="message-list"] [data-slot="message-list-item"]'
  )
  if (rows.length !== expected) return null
  return rows[index] ?? null
}

function flashRow(row: HTMLElement) {
  row.scrollIntoView({ block: "center", behavior: "smooth" })
  row.classList.add(...FLASH_CLASSES)
  setTimeout(() => row.classList.remove(...FLASH_CLASSES), FLASH_MS)
}

/**
 * Opening a chat *at* one message — what selecting a row of the palette's
 * Messages group does.
 *
 * Everything it reads comes from refs, so the callback is stable and never
 * reaches the memoized message rows as a new identity. The order is the only
 * subtle part: the chat is opened first, its transcript is awaited (the LRU
 * may well have dropped it), and only then does a frame loop wait for the list
 * to be showing *that* chat before it scrolls. The extra frame at the end is
 * there because `MessageList` scrolls itself to the bottom when a conversation
 * opens, and the jump has to be the last word.
 *
 * Every failure is silent and leaves the chat open, which is the feature minus
 * the scroll: a message the transcript no longer carries, a chat the user left
 * again while it loaded, a list that never settled.
 */
export function useMessageJump({
  refs,
  selectSession,
  loadThread,
}: {
  refs: ChatRefs
  selectSession: (id: string) => void
  loadThread: LoadThread
}) {
  const { activeIdRef, threadsRef } = refs
  return React.useCallback(
    (sessionId: string, messageId: string) => {
      if (!sessionId) return
      if (activeIdRef.current !== sessionId) selectSession(sessionId)
      void (async () => {
        const thread =
          threadsRef.current[sessionId] ?? (await loadThread(sessionId))
        if (!thread) return
        // The list renders the visible transcript, and the app's own turns are
        // not in it — so the row index is counted the same way.
        const visible = thread.filter((message) => !isInternalMessage(message))
        const index = visible.findIndex((message) => message.id === messageId)
        if (index < 0) return
        let frames = 0
        const step = () => {
          if (frames++ > MAX_REVEAL_FRAMES) return
          const row =
            activeIdRef.current === sessionId
              ? messageRow(index, visible.length)
              : null
          if (!row) {
            requestAnimationFrame(step)
            return
          }
          requestAnimationFrame(() => flashRow(row))
        }
        requestAnimationFrame(step)
      })()
    },
    [activeIdRef, loadThread, selectSession, threadsRef]
  )
}
