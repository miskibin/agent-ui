"use client"

import { ExternalLink, FolderOpen, Sparkles, SquareTerminal } from "lucide-react"
import * as React from "react"

import type {
  CommandPaletteAction,
  CommandPaletteSession,
} from "@/components/command-palette"
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
