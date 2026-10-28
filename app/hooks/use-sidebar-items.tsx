"use client"

import {
  AlarmClockOff,
  CornerDownRight,
  Archive,
  ArchiveRestore,
  Bot,
  ExternalLink,
  FolderInput,
  FolderOpen,
  Pin,
  PinOff,
  Sparkles,
  SquareTerminal,
  Trash2,
} from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import {
  SidebarItemStatusLabel,
  type ChatSidebarItemData,
  type SidebarItemMenuAction,
  type SidebarItemRenderActions,
} from "@/components/ui/chat-sidebar"
import type { GenerationStage } from "@/components/ui/generation-status"
import { RelativeTime } from "@/components/live-time"
import { HarnessLogo } from "@/components/provider-logo"
import {
  SIDEBAR_ROW_ACTION,
  SnoozeAction,
  WokePill,
} from "@/components/sidebar-sections"
import * as api from "@/lib/api-client"
import { findPendingAsk } from "@/lib/ask-tools"
import { errorMessage } from "@/lib/chat-helpers"
import { folderName } from "@/lib/folder"
import {
  AGENTS_SHELF_ID,
  SHELF_PAGE_SIZE,
  SHELF_PAGE_STEP,
  SETTLED_SHELF_ID,
  SNOOZED_SHELF_ID,
  groupSessions,
  shelfOpenKey,
} from "@/lib/session-groups"
import {
  isSettled,
  isSnoozed,
  nextWake,
  sessionSection,
  settledTimestamp,
  wokeAt,
} from "@/lib/session-lifecycle"
import { snoozeWakeDescription } from "@/lib/snooze"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"

import type { SessionRun } from "./chat-types"
import type { ChatRefs } from "./use-chat-refs"

const STAGE_SUBTITLES: Record<Exclude<GenerationStage, "idle">, string> = {
  thinking: "Thinking",
  searching: "Searching",
  responding: "Responding",
}

/**
 * `setTimeout` delays are signed 32-bit: a longer one overflows and fires
 * immediately, which would turn a far-future wake into a tight re-arm loop.
 * Clamped, the timer simply re-arms every ~24.8 days until the wake is in
 * range.
 */
const MAX_TIMEOUT = 2_147_483_647

const EMPTY_THREADS: Record<string, StoredMessage[]> = {}

/** The platform never changes under a page, so there is nothing to subscribe to. */
const subscribeNever = () => () => {}
const EMPTY_SECTIONS: Record<string, boolean> = {}

/**
 * The sidebar's view model: one row per chat, then the pinned group, one
 * section per working folder, and the three shelves — Agents, for the chats
 * an outside agent started, then Snoozed and Settled for what is not in play.
 *
 * The live labels are components rather than strings, so a running turn ticks
 * its own "Working · 12s" (written straight to the DOM by the vendored
 * `SidebarItemStatusLabel`) without a page-level clock re-rendering the
 * sidebar, the composer and the message list once a second for one label.
 */
export function useSidebarItems({
  refs,
  sessions,
  runs,
  failures,
  activeId,
  providerName,
  threads = EMPTY_THREADS,
  closedSections = EMPTY_SECTIONS,
  regenerateTitle,
  onTogglePin,
  onDelete,
  onSettle,
  onSnooze,
  onWake,
  onMarkVisited,
  onAdopt,
}: {
  refs: ChatRefs
  sessions: SessionMeta[]
  runs: Record<string, SessionRun>
  failures: Record<string, boolean>
  activeId: string
  providerName: (id: string) => string
  /**
   * Loaded transcripts. Only used to find the chats holding an unanswered
   * question — a chat that has never been opened this session cannot be
   * waiting on anything, so this is as complete as it needs to be.
   */
  threads?: Record<string, StoredMessage[]>
  /** Folded sections, including the two shelf keys — see `shelfOpenKey`. */
  closedSections?: Record<string, boolean>
  regenerateTitle: (id: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
  onDelete: (id: string) => void
  /** Lifecycle mutations — see `use-chat-actions`. Absent = control hidden. */
  onSettle?: (id: string, settled: boolean) => void
  onSnooze?: (id: string, until: number) => void
  onWake?: (id: string) => void
  onMarkVisited?: (id: string) => void
  /** Takes an outside agent's chat over — off the Agents shelf, into its folder. */
  onAdopt?: (id: string) => void
}) {
  const { orderedIdsRef, sessionsRef } = refs

  /**
   * The instant the sidebar's split is taken at.
   *
   * It is state rather than a fresh `Date.now()` per render because a snooze
   * expiring is the only thing that can change the answer on its own, and the
   * timer below moves the clock exactly then — one re-render at the boundary
   * instead of a clock ticking against a memoized list.
   */
  const [now, setNow] = React.useState(() => Date.now())
  const wakeAt = React.useMemo(() => nextWake(sessions, now), [sessions, now])

  React.useEffect(() => {
    if (wakeAt === null) return
    const delay = Math.min(Math.max(0, wakeAt - Date.now()) + 50, MAX_TIMEOUT)
    const timer = window.setTimeout(() => setNow(Date.now()), delay)
    return () => window.clearTimeout(timer)
  }, [wakeAt, now])

  /**
   * Chats holding a question nobody has answered. Derived through a joined key
   * so the set keeps one identity while the answer is unchanged: `threads` is
   * rewritten on every streamed token, and the row list must not be.
   */
  const awaitingKey = React.useMemo(
    () =>
      Object.entries(threads)
        .filter(([id, thread]) => !runs[id] && findPendingAsk(thread) !== null)
        .map(([id]) => id)
        .sort()
        .join(" "),
    [runs, threads]
  )
  const awaiting = React.useMemo(
    () => new Set(awaitingKey ? awaitingKey.split(" ") : []),
    [awaitingKey]
  )

  const sessionItems = React.useMemo<ChatSidebarItemData[]>(
    () =>
      sessions.map((session) => {
        const run = runs[session.id]
        const section = sessionSection(session, now)
        const woke = wokeAt(session, now)

        // A shelved chat is a single line: no model, no folder, just what it
        // is called and when it comes back. The rows above are the ones doing
        // the work, and they are what the eye should land on.
        if (section === "snoozed" || section === "settled") {
          return {
            id: session.id,
            title: session.title,
            pinned: session.pinned,
            recede: true,
            meta:
              section === "snoozed" ? (
                <span className="tabular-nums">
                  {snoozeWakeDescription(session.snoozedUntil ?? 0, now)}
                </span>
              ) : (
                <RelativeTime from={settledTimestamp(session)} />
              ),
          }
        }

        const subtitle = run
          ? (run.status ??
            STAGE_SUBTITLES[run.stage === "idle" ? "thinking" : run.stage])
          : // The folder is the section header now, so the row is free to say
            // what answered in it.
            session.messageCount === 0
            ? "New chat"
            : (
                <>
                  {/* Filed under the chat whose agent started it. */}
                  {session.parentId ? "Subagent · " : null}
                  {/* On the Agents shelf there is no folder header above the
                      row, so the row names the folder itself. */}
                  {session.external && session.cwd
                    ? `${folderName(session.cwd)} · `
                    : null}
                  <HarnessLogo
                    providerId={session.providerId}
                    name={providerName(session.providerId)}
                    className="inline size-3.5 align-[-2px]"
                  />
                </>
              )
        // Three colours and no more: amber for a chat waiting on an answer,
        // the app's own for one that is working, destructive for one that
        // broke. A chat asking a question outranks one that is merely busy.
        const status = awaiting.has(session.id)
          ? ("pending" as const)
          : run
            ? ("streaming" as const)
            : failures[session.id]
              ? ("fault" as const)
              : undefined
        return {
          id: session.id,
          title: session.title,
          pinned: session.pinned,
          status,
          // A subagent chat sits right under its parent (`nestUnderParents`);
          // the corner says so wherever no status dot needs the slot.
          // A chat an outside agent started gets the robot in the same slot.
          leading:
            session.parentId && !status ? (
              <CornerDownRight
                aria-hidden
                data-slot="sidebar-subagent-mark"
                className="size-3 text-muted-foreground/70"
              />
            ) : session.external && !status ? (
              <Bot
                aria-hidden
                data-slot="sidebar-external-mark"
                className="size-3 text-muted-foreground/70"
              />
            ) : undefined,
          // Background work should not compete with the chat you are reading:
          // a turn running in another chat dims until you hover it. A chat
          // waiting on an *answer* never recedes — it is the one asking.
          recede: !!run && session.id !== activeId,
          subtitle,
          meta:
            woke !== null && onMarkVisited ? (
              <WokePill
                title={session.title}
                onDismiss={() => onMarkVisited(session.id)}
              />
            ) : awaiting.has(session.id) ? (
              <SidebarItemStatusLabel status="pending" label="Awaiting input" />
            ) : run ? (
              <SidebarItemStatusLabel
                status="streaming"
                label="Working"
                startedAt={run.startedAt}
              />
            ) : failures[session.id] ? (
              <SidebarItemStatusLabel status="fault" label="Failed" />
            ) : (
              <RelativeTime from={session.updatedAt} />
            ),
        }
      }),
    [
      activeId,
      awaiting,
      failures,
      now,
      onMarkVisited,
      providerName,
      runs,
      sessions,
    ]
  )

  /**
   * How far each shelf is paged. Reset is deliberately absent: a shelf the
   * user opened deeply stays that way until the sidebar unmounts, which is
   * the same life the fold state has in this session.
   */
  const [shelfPages, setShelfPages] = React.useState<Record<string, number>>({})
  const showMoreOnShelf = React.useCallback((id: string) => {
    setShelfPages((prev) => ({
      ...prev,
      [id]: (prev[id] ?? SHELF_PAGE_SIZE) + SHELF_PAGE_STEP,
    }))
  }, [])

  /** Pinned chats, one section per working folder, then the three shelves. */
  const {
    pinned: pinnedItems,
    folders: folderGroups,
    agents: agentsShelf,
    snoozed: snoozedShelf,
    settled: settledShelf,
  } = React.useMemo(
    () =>
      groupSessions(sessions, sessionItems, {
        now,
        // The open chat is never a row that is not there — not behind a fold
        // and not behind "Show more".
        keepVisible: activeId ? [activeId] : [],
        // An outside agent's question still needs an answer: its row stays
        // out even while the Agents shelf is folded.
        attention: [...awaiting],
        agentsOpen: !!closedSections[shelfOpenKey(AGENTS_SHELF_ID)],
        agentsVisible: shelfPages[AGENTS_SHELF_ID],
        snoozedOpen: !!closedSections[shelfOpenKey(SNOOZED_SHELF_ID)],
        settledOpen: !!closedSections[shelfOpenKey(SETTLED_SHELF_ID)],
        snoozedVisible: shelfPages[SNOOZED_SHELF_ID],
        settledVisible: shelfPages[SETTLED_SHELF_ID],
      }),
    [
      activeId,
      awaiting,
      closedSections,
      now,
      sessionItems,
      sessions,
      shelfPages,
    ]
  )

  /**
   * The first nine rows in jump order carry the shortcut that opens them —
   * ⌥1…9 — shown while ⌥ is held (`ChatSidebar showJumpHints`). Only those
   * nine rows are rebuilt when the order moves.
   */
  const apple = React.useSyncExternalStore(
    subscribeNever,
    () => /Mac|iPhone|iPad|iPod/.test(navigator.platform),
    () => false
  )
  const jumpLabelled = React.useMemo(() => {
    const label = (item: ChatSidebarItemData, position: number) =>
      position < 9
        ? {
            ...item,
            jumpLabel: apple ? `⌥${position + 1}` : `Alt ${position + 1}`,
          }
        : item
    // Where each folder's rows start in the one sequence the shortcuts count.
    const starts = folderGroups.reduce<number[]>(
      (acc, group, i) => [
        ...acc,
        i === 0
          ? pinnedItems.length
          : acc[i - 1] + folderGroups[i - 1].items.length,
      ],
      []
    )
    return {
      pinned: pinnedItems.map((item, i) => label(item, i)),
      folders: folderGroups.map((group, g) =>
        starts[g] >= 9
          ? group
          : {
              ...group,
              items: group.items.map((item, i) => label(item, starts[g] + i)),
            }
      ),
    }
  }, [apple, folderGroups, pinnedItems])

  React.useEffect(() => {
    orderedIdsRef.current = [
      ...pinnedItems,
      ...folderGroups.flatMap((group) => group.items),
      ...agentsShelf.items,
      ...snoozedShelf.items,
      ...settledShelf.items,
    ].map((item) => item.id)
  }, [
    agentsShelf.items,
    folderGroups,
    orderedIdsRef,
    pinnedItems,
    settledShelf.items,
    snoozedShelf.items,
  ])

  /**
   * The row's own controls, in the slot the timestamp holds at rest: put the
   * chat down, file it away, pin it, delete it. The same verbs the context
   * menu carries — this is the version you can reach without a right-click.
   *
   * Every one of them reads the chat back through the sidebar mirror rather
   * than closing over it, so the callback keeps one identity for the life of
   * the page and the memoized rows are never rebuilt for it.
   */
  const sessionRowActions = React.useCallback<SidebarItemRenderActions>(
    (item) => {
      const session = sessionsRef.current.find((entry) => entry.id === item.id)
      const pinned = !!session?.pinned
      const snoozed = !!session && isSnoozed(session, Date.now())
      const settled = !!session && isSettled(session)
      return (
        <>
          {snoozed
            ? onWake && (
                <button
                  type="button"
                  className={SIDEBAR_ROW_ACTION}
                  title="Wake chat"
                  aria-label={`Wake ${item.title}`}
                  onClick={() => onWake(item.id)}
                >
                  <AlarmClockOff />
                </button>
              )
            : onSnooze && (
                <SnoozeAction
                  title={item.title}
                  onSnooze={(until) => onSnooze(item.id, until)}
                />
              )}
          {onSettle ? (
            <button
              type="button"
              className={SIDEBAR_ROW_ACTION}
              title={settled ? "Move back to active" : "Settle chat"}
              aria-label={
                settled ? `Reopen ${item.title}` : `Settle ${item.title}`
              }
              onClick={() => onSettle(item.id, !settled)}
            >
              {settled ? <ArchiveRestore /> : <Archive />}
            </button>
          ) : null}
          <button
            type="button"
            className={SIDEBAR_ROW_ACTION}
            title={pinned ? "Unpin chat" : "Pin chat"}
            aria-label={pinned ? `Unpin ${item.title}` : `Pin ${item.title}`}
            onClick={() => onTogglePin(item.id, !pinned)}
          >
            {pinned ? <PinOff /> : <Pin />}
          </button>
          <button
            type="button"
            className={SIDEBAR_ROW_ACTION}
            title="Delete chat"
            aria-label={`Delete ${item.title}`}
            // No confirmation: the delete toast offers "Restore" instead.
            onClick={() => onDelete(item.id)}
          >
            <Trash2 />
          </button>
        </>
      )
    },
    [onDelete, onSettle, onSnooze, onTogglePin, onWake, sessionsRef]
  )

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
      if (onAdopt && session?.external) {
        actions.push({
          id: "adopt",
          label: session.cwd
            ? `Move to ${folderName(session.cwd)}`
            : "Move to my chats",
          icon: <FolderInput className="size-3.5" />,
          onSelect: () => onAdopt(item.id),
          separatorBefore: true,
        })
      }
      const settled = !!session && isSettled(session)
      if (onSettle) {
        actions.push({
          id: "settle",
          label: settled ? "Move back to active" : "Settle chat",
          icon: settled ? (
            <ArchiveRestore className="size-3.5" />
          ) : (
            <Archive className="size-3.5" />
          ),
          onSelect: () => onSettle(item.id, !settled),
          separatorBefore: true,
        })
      }
      if (onWake && session && isSnoozed(session, Date.now())) {
        actions.push({
          id: "wake",
          label: "Wake now",
          icon: <AlarmClockOff className="size-3.5" />,
          onSelect: () => onWake(item.id),
        })
      }
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
    [onAdopt, onSettle, onWake, regenerateTitle, sessionsRef]
  )

  return {
    sessionItems,
    pinnedItems: jumpLabelled.pinned,
    folderGroups: jumpLabelled.folders,
    agentsShelf,
    snoozedShelf,
    settledShelf,
    showMoreOnShelf,
    sessionMenuActions,
    sessionRowActions,
  }
}
