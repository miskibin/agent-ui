"use client"

import { ExternalLink, FolderOpen, Sparkles, SquareTerminal } from "lucide-react"
import * as React from "react"

import type {
  CommandPaletteAction,
  CommandPaletteSession,
} from "@/components/command-palette"
import { searchChatMessages } from "@/lib/api-client"
import {
  MIN_SEARCH_QUERY,
  type MessageSearchHit,
} from "@/lib/message-search"
import type { SessionMeta } from "@/lib/store/types"

/** What ⌘K offers: every chat, plus the actions that apply to the open one. */
export function useCommandPalette({
  sessions,
  activeId,
  activeCwd,
  providerName,
  regenerateTitle,
  openFolder,
}: {
  sessions: SessionMeta[]
  activeId: string
  activeCwd: string | undefined
  providerName: (id: string) => string
  regenerateTitle: (id: string) => void
  openFolder: (action: "editor" | "reveal" | "terminal") => void
}) {
  const paletteActions = React.useMemo<CommandPaletteAction[]>(() => {
    if (!activeId) return []
    const actions: CommandPaletteAction[] = [
      {
        id: "title",
        label: "Regenerate chat title",
        icon: <Sparkles />,
        onSelect: () => regenerateTitle(activeId),
      },
    ]
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
  }, [activeCwd, activeId, openFolder, regenerateTitle])

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
