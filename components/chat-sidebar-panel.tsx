"use client"

import { arrayMove } from "@dnd-kit/sortable"
import {
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings as SettingsIcon,
} from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { SidebarLoading } from "@/components/chat-skeletons"
import {
  SidebarFolderSection,
  SidebarSessionSection,
  SidebarShelfSection,
} from "@/components/sidebar-sections"
import {
  ChatSidebar,
  ChatSidebarDnd,
  ChatSidebarItemGhost,
  SideIconBtn,
  SideRow,
  SidebarCollapsibleSection,
  SidebarEmptyState,
  SidebarResizeRail,
  type ChatSidebarItemData,
  type SidebarItemMenuAction,
  type SidebarItemRenderActions,
} from "@/components/ui/chat-sidebar"
import { ThemeToggle } from "@/components/ui/theme-toggle"
import * as api from "@/lib/api-client"
import { errorMessage } from "@/lib/chat-helpers"
import {
  PINNED_GROUP_ID,
  SETTLED_SHELF_ID,
  SNOOZED_SHELF_ID,
  groupIdForSession,
  shelfOpenKey,
  sidebarListId,
  type SessionGroup,
  type SessionShelf,
} from "@/lib/session-groups"
import type { SessionMeta } from "@/lib/store/types"

/** The vendored toggle, dressed as a sidebar icon button. */
const SIDEBAR_THEME_TOGGLE =
  "size-8 rounded-md border-0 bg-transparent text-muted-foreground shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"

/** The empty-state section has nothing to fold, so its trigger does nothing. */
function noop() {}

/**
 * The whole left pane: the rail, the nav rows, the pinned group, one section
 * per working folder, and the Snoozed and Settled shelves under them.
 *
 * Memoized, and given nothing but already-derived lists and stable callbacks —
 * the chat list only moves when a session does, so keeping it out of the render
 * a streaming turn drives means the sidebar is not rebuilt every frame.
 */
export const ChatSidebarPanel = React.memo(function ChatSidebarPanel({
  sessionItems,
  pinnedItems,
  folderGroups,
  snoozedShelf,
  settledShelf,
  onShelfShowMore,
  onSettle,
  onWake,
  activeId,
  sessionsLoaded,
  sessionsRef,
  closedSections,
  onToggleSection,
  renameRequest,
  isDesktop,
  collapsed,
  onCollapsedChange,
  onCloseDrawer,
  onNewChat,
  onOpenPalette,
  onOpenSettings,
  onSelect,
  onRename,
  onTogglePin,
  onDelete,
  onDeleteMany,
  onReorder,
  getMenuActions,
  renderActions,
  sidebarWidth,
  onSidebarWidthChange,
}: {
  sessionItems: ChatSidebarItemData[]
  pinnedItems: ChatSidebarItemData[]
  folderGroups: SessionGroup[]
  /** The two shelves — see `lib/session-groups`. Absent = neither renders. */
  snoozedShelf?: SessionShelf
  settledShelf?: SessionShelf
  onShelfShowMore?: (id: string) => void
  /** What a drop on (or off) the Settled shelf means. */
  onSettle?: (id: string, settled: boolean) => void
  /** What a drag off the Snoozed shelf means. */
  onWake?: (id: string) => void
  activeId: string
  sessionsLoaded: boolean
  /** Read on drop only: the drag indices are per-list, the ids are not. */
  sessionsRef: React.RefObject<SessionMeta[]>
  closedSections: Record<string, boolean>
  onToggleSection: (id: string) => void
  renameRequest: { id: string; token: number }
  isDesktop: boolean
  collapsed: boolean
  onCollapsedChange: (next: boolean) => void
  onCloseDrawer: () => void
  onNewChat: () => void
  onOpenPalette: () => void
  onOpenSettings: () => void
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
  onDelete: (id: string) => void
  onDeleteMany: (ids: string[]) => void
  onReorder: (updater: (prev: SessionMeta[]) => SessionMeta[]) => void
  getMenuActions: (item: ChatSidebarItemData) => SidebarItemMenuAction[]
  /** Pin and delete on the row, in the slot the timestamp holds at rest. */
  renderActions: SidebarItemRenderActions
  /** Persisted panel width, hydrated before the first paint; 0 = never set. */
  sidebarWidth: number
  onSidebarWidthChange: (width: number) => void
}) {
  /**
   * The list a chat is filed under — the pinned group, its folder's section,
   * or the folderless one. It is what makes a drag across sections mean
   * something: `lib/session-groups` computes the same id the lists register
   * themselves with.
   */
  const listOf = (id: string) => {
    const session = sessionsRef.current.find((item) => item.id === id)
    // The list a chat is *in*, shelves included — the folder it belongs to is
    // not where it is rendered once it has been snoozed or settled.
    return session ? sidebarListId(session) : null
  }

  /** Where an unpinned, awake, unsettled chat would land. */
  const folderListOf = (id: string) => {
    const session = sessionsRef.current.find((item) => item.id === id)
    return session ? groupIdForSession({ ...session, pinned: false }) : null
  }

  return (
    <ChatSidebarDnd
      /*
       * What a cross-list drop would do — the badge on the lifted row is what
       * says which verb the pointer is currently over. The destination
       * decides first (it is the deliberate half of the gesture); the origin
       * only matters when the row is being dragged back out of somewhere.
       */
      resolveDropVerb={(fromListId, toListId) => {
        if (toListId === PINNED_GROUP_ID) {
          return { label: "Pin", icon: <Pin aria-hidden className="size-3" /> }
        }
        if (toListId === SETTLED_SHELF_ID) {
          return {
            label: "Settle",
            icon: <Archive aria-hidden className="size-3" />,
          }
        }
        if (fromListId === SETTLED_SHELF_ID) {
          return {
            label: "Unsettle",
            icon: <ArchiveRestore aria-hidden className="size-3" />,
          }
        }
        if (fromListId === SNOOZED_SHELF_ID) {
          return {
            label: "Wake",
            icon: <AlarmClockOff aria-hidden className="size-3" />,
          }
        }
        if (fromListId === PINNED_GROUP_ID) {
          return {
            label: "Unpin",
            icon: <PinOff aria-hidden className="size-3" />,
          }
        }
        return null
      }}
      /*
       * Refuse the drops the app cannot honour, so a rejected target falls
       * back to the row it was lifted from instead of landing somewhere that
       * silently does nothing: a chat moves into the pinned group and back to
       * its own folder, and nowhere else. A reorder survives only inside the
       * pinned group (`lib/session-groups`), so that is the only list whose
       * rows accept one.
       */
      canDrop={(itemId, overId) => {
        const from = listOf(itemId)
        const to = listOf(overId)
        // A zone, or a row this sidebar does not know: leave it to the zones.
        if (from === null || to === null) return true
        // Nothing is ever dropped *into* Snoozed: a snooze is a wake time,
        // and a drag has none to give. The row action's popover is the only
        // way in, and dragging back out is the way to undo it.
        if (to === SNOOZED_SHELF_ID) return false
        if (to === PINNED_GROUP_ID) return true
        if (to === SETTLED_SHELF_ID) return !!onSettle
        // Off a shelf or out of the pinned group, back to where the chat
        // belongs. Any other section is a move this app has nothing to write
        // back for — a chat's folder is not a thing you drag it into.
        if (
          from === PINNED_GROUP_ID ||
          from === SETTLED_SHELF_ID ||
          from === SNOOZED_SHELF_ID
        ) {
          return to === folderListOf(itemId)
        }
        return false
      }}
      onDrop={(drop) => {
        if (drop.kind === "reorder") {
          // Only the pinned list reorders by hand: a folder section is
          // ordered by activity, and `order` is one global sequence with
          // nothing per-folder to write back to. `from`/`to` are indices
          // inside their own list, so the ids are what map onto `sessions`.
          if (drop.fromListId !== drop.listId) {
            /*
             * A drag that crosses lists is the verb the lifted row was
             * showing, and it is applied in the same order the badge picked
             * it. Pinning a chat that was snoozed or settled has to undo
             * those too — snooze and settled both outrank a pin, so a pin
             * that left them in place would move the row nowhere.
             */
            const wasSnoozed = drop.fromListId === SNOOZED_SHELF_ID
            const wasSettled = drop.fromListId === SETTLED_SHELF_ID
            if (drop.listId === PINNED_GROUP_ID) {
              if (wasSnoozed) onWake?.(drop.itemId)
              if (wasSettled) onSettle?.(drop.itemId, false)
              onTogglePin(drop.itemId, true)
            } else if (drop.listId === SETTLED_SHELF_ID) {
              if (wasSnoozed) onWake?.(drop.itemId)
              onSettle?.(drop.itemId, true)
            } else if (wasSettled) {
              onSettle?.(drop.itemId, false)
            } else if (wasSnoozed) {
              onWake?.(drop.itemId)
            } else if (drop.fromListId === PINNED_GROUP_ID) {
              onTogglePin(drop.itemId, false)
            }
            return
          }
          // Only the pinned list reorders by hand: a folder section is ordered
          // by activity, and `order` is one global sequence with nothing
          // per-folder to write back to.
          if (drop.listId !== PINNED_GROUP_ID) return
          const list = sessionsRef.current
          const from = list.findIndex((item) => item.id === drop.itemId)
          const to = list.findIndex((item) => item.id === drop.overId)
          if (from < 0 || to < 0 || from === to) return
          onReorder((prev) => arrayMove(prev, from, to))
          void api
            .patchSession(drop.itemId, { order: to })
            .catch((err: unknown) =>
              toast.error(errorMessage(err, "Could not reorder chats"))
            )
        } else if (drop.action === "pin") {
          onTogglePin(drop.itemId, true)
        } else if (drop.action === "delete") {
          onDelete(drop.itemId)
          toast.message("Chat deleted")
        }
      }}
      renderOverlay={(id) => {
        const item = sessionItems.find((session) => session.id === id)
        if (!item) return null
        return <ChatSidebarItemGhost item={item} active={item.id === activeId} />
      }}
    >
      <ChatSidebar
        collapsed={isDesktop ? collapsed : false}
        onCollapsedChange={(next) =>
          isDesktop ? onCollapsedChange(next) : onCloseDrawer()
        }
        edgeZones
        /*
         * The drag writes `--chat-sidebar-width` on the panel itself, once per
         * frame, and tells React only on release — which is why the width is
         * not state here. Disabled while collapsed: the rail is 60px wide and
         * has nothing to resize.
         */
        overlays={
          <SidebarResizeRail
            width={sidebarWidth || undefined}
            disabled={isDesktop && collapsed}
            onWidthChange={onSidebarWidthChange}
          />
        }
        // No rules under the header or above the footer (`dividers` defaults
        // off): the sections are told apart by their own header rules and the
        // space between them, which is what this gap is for.
        classNames={{ content: "flex flex-col gap-2 pt-2" }}
        brand={
          <span className="truncate px-1 text-[15px] font-semibold tracking-tight text-foreground">
            Chats
          </span>
        }
        nav={
          <>
            <SideRow icon={<Pencil className="size-4" />} onClick={onNewChat}>
              New chat
            </SideRow>
            <SideRow
              icon={<Search className="size-4" />}
              hint="⌘K"
              onClick={onOpenPalette}
            >
              Search chats
            </SideRow>
          </>
        }
        rail={
          <>
            <SideIconBtn label="New chat" onClick={onNewChat}>
              <Pencil className="size-4" />
            </SideIconBtn>
            <SideIconBtn label="Search chats" onClick={onOpenPalette}>
              <Search className="size-4" />
            </SideIconBtn>
          </>
        }
        footer={
          (isDesktop ? collapsed : false) ? (
            <>
              <SideIconBtn label="Settings" onClick={onOpenSettings}>
                <SettingsIcon className="size-4" />
              </SideIconBtn>
              <ThemeToggle floating={false} className={SIDEBAR_THEME_TOGGLE} />
            </>
          ) : (
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <SideRow
                  icon={<SettingsIcon className="size-4" />}
                  onClick={onOpenSettings}
                >
                  Settings
                </SideRow>
              </div>
              <ThemeToggle floating={false} className={SIDEBAR_THEME_TOGGLE} />
            </div>
          )
        }
      >
        {sessionItems.length === 0 ? (
          <SidebarCollapsibleSection title="Chats" open onToggle={noop}>
            {!sessionsLoaded ? (
              <SidebarLoading />
            ) : (
              <SidebarEmptyState>New chats appear here.</SidebarEmptyState>
            )}
          </SidebarCollapsibleSection>
        ) : null}

        {pinnedItems.length > 0 ? (
          <SidebarSessionSection
            id={PINNED_GROUP_ID}
            title="Pinned"
            sortable
            open={!closedSections[PINNED_GROUP_ID]}
            onToggle={onToggleSection}
            sessions={pinnedItems}
            activeId={activeId}
            renameRequest={renameRequest}
            onSelect={onSelect}
            onRename={onRename}
            onTogglePin={onTogglePin}
            onDelete={onDelete}
            onDeleteMany={onDeleteMany}
            getMenuActions={getMenuActions}
            renderActions={renderActions}
          />
        ) : null}

        {folderGroups.map((group) => (
          <SidebarFolderSection
            key={group.id}
            group={group}
            open={!closedSections[group.id]}
            onToggle={onToggleSection}
            activeId={activeId}
            renameRequest={renameRequest}
            onSelect={onSelect}
            onRename={onRename}
            onTogglePin={onTogglePin}
            onDelete={onDelete}
            onDeleteMany={onDeleteMany}
            getMenuActions={getMenuActions}
            renderActions={renderActions}
          />
        ))}

        {/* The shelves come last and start folded: what is not in play should
            be reachable, not in the way. Their fold key is inverted — see
            `shelfOpenKey`. */}
        {[snoozedShelf, settledShelf].map((shelf) =>
          shelf && shelf.total > 0 && onShelfShowMore ? (
            <SidebarShelfSection
              key={shelf.id}
              shelf={shelf}
              open={!!closedSections[shelfOpenKey(shelf.id)]}
              onToggle={onToggleSection}
              onShowMore={onShelfShowMore}
              activeId={activeId}
              renameRequest={renameRequest}
              onSelect={onSelect}
              onRename={onRename}
              onTogglePin={onTogglePin}
              onDelete={onDelete}
              onDeleteMany={onDeleteMany}
              getMenuActions={getMenuActions}
              renderActions={renderActions}
            />
          ) : null
        )}
      </ChatSidebar>
    </ChatSidebarDnd>
  )
})
