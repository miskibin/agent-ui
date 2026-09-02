"use client"

import { ExternalLink, FolderOpen, Sparkles, SquareTerminal } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import type {
  ChatSidebarItemData,
  SidebarItemMenuAction,
} from "@/components/ui/chat-sidebar"
import type { GenerationStage } from "@/components/ui/generation-status"
import type { ModelOption } from "@/components/ui/model-picker"
import { RelativeTime, WorkingFor } from "@/components/live-time"
import * as api from "@/lib/api-client"
import { errorMessage } from "@/lib/chat-helpers"
import { groupSessions } from "@/lib/session-groups"
import type { SessionMeta } from "@/lib/store/types"

import type { SessionRun } from "./chat-types"
import type { ChatRefs } from "./use-chat-refs"

const STAGE_SUBTITLES: Record<Exclude<GenerationStage, "idle">, string> = {
  thinking: "Thinking",
  searching: "Searching",
  responding: "Responding",
}

/**
 * The sidebar's view model: one row per chat, then the pinned group and one
 * section per working folder.
 *
 * The live labels are components rather than strings, so a running turn ticks
 * its own "Working · 12s" without a page-level clock re-rendering the sidebar,
 * the composer and the message list once a second for one label.
 */
export function useSidebarItems({
  refs,
  sessions,
  runs,
  failures,
  activeId,
  providerId,
  models,
  providerName,
  regenerateTitle,
}: {
  refs: ChatRefs
  sessions: SessionMeta[]
  runs: Record<string, SessionRun>
  failures: Record<string, boolean>
  activeId: string
  providerId: string
  models: ModelOption[]
  providerName: (id: string) => string
  regenerateTitle: (id: string) => void
}) {
  const { orderedIdsRef, sessionsRef } = refs

  const sessionItems = React.useMemo<ChatSidebarItemData[]>(
    () =>
      sessions.map((session) => {
        const run = runs[session.id]
        const subtitle = run
          ? (run.status ??
            STAGE_SUBTITLES[run.stage === "idle" ? "thinking" : run.stage])
          : // The folder is the section header now, so the row is free to say
            // what answered in it.
            session.messageCount === 0
            ? "New chat"
            : [
                providerName(session.providerId),
                session.providerId === providerId
                  ? (models.find((m) => m.id === session.model)?.name ??
                    session.model)
                  : session.model,
              ]
                .filter(Boolean)
                .join(" · ")
        return {
          id: session.id,
          title: session.title,
          pinned: session.pinned,
          status: run ? "streaming" : failures[session.id] ? "fault" : undefined,
          subtitle,
          meta: run ? (
            <WorkingFor startedAt={run.startedAt} dim={session.id !== activeId} />
          ) : failures[session.id] ? (
            <span className="font-medium text-destructive">Failed</span>
          ) : (
            <RelativeTime from={session.updatedAt} />
          ),
        }
      }),
    [activeId, failures, models, providerId, providerName, runs, sessions]
  )

  /** Pinned chats, then one section per working folder. */
  const { pinned: pinnedItems, folders: folderGroups } = React.useMemo(
    () => groupSessions(sessions, sessionItems),
    [sessionItems, sessions]
  )

  React.useEffect(() => {
    orderedIdsRef.current = [
      ...pinnedItems,
      ...folderGroups.flatMap((group) => group.items),
    ].map((item) => item.id)
  }, [folderGroups, orderedIdsRef, pinnedItems])

  /**
   * Extra entries on a chat row's right-click menu. Built per row by the
   * list, which memoizes on this callback and the row's item.
   */
  const sessionMenuActions = React.useCallback(
    (item: ChatSidebarItemData): SidebarItemMenuAction[] => {
      const session = sessionsRef.current.find((entry) => entry.id === item.id)
      const actions: SidebarItemMenuAction[] = [
        {
          id: "title",
          label: "Regenerate title",
          icon: <Sparkles className="size-3.5" />,
          onSelect: () => regenerateTitle(item.id),
        },
      ]
      const cwd = session?.cwd?.trim()
      if (cwd) {
        const open = (action: "editor" | "reveal" | "terminal") =>
          void api
            .openPath({ action, path: cwd, sessionId: item.id })
            .catch((err: unknown) =>
              toast.error(errorMessage(err, "Could not open the folder"))
            )
        actions.push(
          {
            id: "open-folder",
            label: "Open folder in editor",
            icon: <ExternalLink className="size-3.5" />,
            onSelect: () => open("editor"),
            separatorBefore: true,
          },
          {
            id: "reveal-folder",
            label: "Reveal folder",
            icon: <FolderOpen className="size-3.5" />,
            onSelect: () => open("reveal"),
          },
          {
            id: "terminal-folder",
            label: "Open in terminal",
            icon: <SquareTerminal className="size-3.5" />,
            onSelect: () => open("terminal"),
          }
        )
      }
      return actions
    },
    [regenerateTitle, sessionsRef]
  )

  return { sessionItems, pinnedItems, folderGroups, sessionMenuActions }
}
