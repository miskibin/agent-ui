"use client"

import { AlarmClock } from "lucide-react"
import * as React from "react"

import { FolderStatus } from "@/components/folder-status"
import {
  ChatSidebarItemList,
  SidebarCollapsibleSection,
  SidebarItemBadge,
  type ChatSidebarItemData,
  type SidebarItemMenuAction,
  type SidebarItemRenderActions,
} from "@/components/ui/chat-sidebar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { SessionGroup, SessionShelf } from "@/lib/session-groups"
import { shelfOpenKey } from "@/lib/session-groups"
import { snoozePresets, snoozeWakeDescription } from "@/lib/snooze"
import { cn } from "@/lib/utils"

/**
 * The hover cluster's buttons — quiet, and sized to the row's meta slot. Lives
 * here because the sidebar's row actions are built in two places: the pin and
 * delete pair in `use-sidebar-items`, and the snooze popover below.
 */
export const SIDEBAR_ROW_ACTION =
  "inline-grid size-5 place-items-center rounded-sm text-current outline-none transition-colors hover:bg-sidebar-accent-foreground/10 focus-visible:ring-2 focus-visible:ring-sidebar-ring/60 [&_svg]:size-3.5"

export type SidebarSectionProps = {
  open: boolean
  /** Takes the section id, so the row of sections shares one stable callback. */
  onToggle: (id: string) => void
  activeId: string
  renameRequest: { id: string; token: number }
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
  onDelete: (id: string) => void
  onDeleteMany: (ids: string[]) => void
  getMenuActions?: (item: ChatSidebarItemData) => SidebarItemMenuAction[]
  /** Pin and delete in the row's meta slot, on hover or keyboard focus. */
  renderActions?: SidebarItemRenderActions
}

export const SidebarSessionSection = React.memo(function SidebarSessionSection({
  id,
  title,
  action,
  toggleId,
  sortable = false,
  rule = false,
  live = false,
  open,
  onToggle,
  sessions,
  ...rest
}: SidebarSectionProps & {
  id: string
  title: React.ReactNode
  /** Rendered at the right edge of the header, before the count. */
  action?: React.ReactNode
  /**
   * The key the fold state is stored under, when it is not the list id — see
   * `shelfOpenKey`, which is the only caller that needs the two to differ.
   */
  toggleId?: string
  /** Hand-made order — only the pinned group has one to keep. */
  sortable?: boolean
  /** Header as a label, a hairline and a chevron — the per-folder shape. */
  rule?: boolean
  /** Something inside is streaming; the header says so while it is folded. */
  live?: boolean
  sessions: ChatSidebarItemData[]
}) {
  const key = toggleId ?? id
  const toggle = React.useCallback(() => onToggle(key), [key, onToggle])
  return (
    <SidebarCollapsibleSection
      title={title}
      open={open}
      onToggle={toggle}
      action={action}
      rule={rule}
      live={live}
      count={sessions.length}
    >
      <ChatSidebarItemList
        items={sessions}
        activeId={rest.activeId}
        listId={id}
        renameRequest={rest.renameRequest}
        sortable={sortable}
        draggable
        // Rows ease between their layout positions — a chat arriving, one
        // being deleted, a drag released. Transform and opacity only, and it
        // stands down entirely under `prefers-reduced-motion`.
        motion
        onSelect={rest.onSelect}
        onRename={rest.onRename}
        onTogglePin={rest.onTogglePin}
        onDelete={rest.onDelete}
        onDeleteMany={rest.onDeleteMany}
        getMenuActions={rest.getMenuActions}
        renderActions={rest.renderActions}
      />
    </SidebarCollapsibleSection>
  )
})

/**
 * One working folder's chats. The header carries what the rows used to repeat —
 * the folder and its branch — and keeps a live dot while the section is closed,
 * so a turn running inside it is never hidden by the fold.
 */
export const SidebarFolderSection = React.memo(function SidebarFolderSection({
  group,
  open,
  ...rest
}: SidebarSectionProps & { group: SessionGroup }) {
  return (
    <SidebarSessionSection
      {...rest}
      id={group.id}
      open={open}
      // One line per working folder: the label, a hairline, the branch and
      // the chevron — rather than a stack of uppercase captions.
      rule
      // The section's own dot while it is folded away. Owned by the component,
      // which stops animating it when the tab or the row goes out of sight.
      live={group.running}
      title={<span title={group.cwd || undefined}>{group.label}</span>}
      action={
        <span className="flex min-w-0 items-center gap-1.5 normal-case">
          {group.branch ? (
            <SidebarItemBadge branch={group.branch} className="min-w-0" />
          ) : null}
          {group.cwd && group.items[0] ? (
            <FolderStatus cwd={group.cwd} sessionId={group.items[0].id} />
          ) : null}
        </span>
      }
      sessions={group.items}
    />
  )
})

/**
 * One shelf — Snoozed or Settled — under the folder sections.
 *
 * Two things it does that a folder section does not. It pages: history should
 * not be able to push live work off the screen, so the shelf renders ten rows
 * and then a count you can press. And it renders its exception rows *outside*
 * the collapsible, because the fold hides its children entirely and the open
 * chat must never be a row that is not there — `groupSessions` decides which
 * rows those are, this only decides where they go.
 */
export const SidebarShelfSection = React.memo(function SidebarShelfSection({
  shelf,
  open,
  onToggle,
  onShowMore,
  ...rest
}: SidebarSectionProps & {
  shelf: SessionShelf
  /** Adds the next page of rows. */
  onShowMore: (id: string) => void
}) {
  const toggle = React.useCallback(
    () => onToggle(shelfOpenKey(shelf.id)),
    [onToggle, shelf.id]
  )
  const showMore = React.useCallback(
    () => onShowMore(shelf.id),
    [onShowMore, shelf.id]
  )

  const rows = (
    <ChatSidebarItemList
      items={shelf.items}
      activeId={rest.activeId}
      listId={shelf.id}
      renameRequest={rest.renameRequest}
      draggable
      motion
      onSelect={rest.onSelect}
      onRename={rest.onRename}
      onTogglePin={rest.onTogglePin}
      onDelete={rest.onDelete}
      onDeleteMany={rest.onDeleteMany}
      getMenuActions={rest.getMenuActions}
      renderActions={rest.renderActions}
    />
  )

  return (
    <div data-slot="sidebar-shelf" data-shelf={shelf.id}>
      <SidebarCollapsibleSection
        title={shelf.label}
        open={open}
        onToggle={toggle}
        rule
        count={shelf.total}
      >
        {rows}
        {shelf.hidden > 0 ? (
          <button
            type="button"
            data-slot="sidebar-shelf-more"
            onClick={showMore}
            className={cn(
              "mt-0.5 w-full rounded-md px-2 py-1 text-left text-[11px]",
              "text-muted-foreground outline-none transition-colors",
              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              "focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
            )}
          >
            Show {shelf.hidden} more
          </button>
        ) : null}
      </SidebarCollapsibleSection>
      {/* The fold's one exception: the open chat keeps its row. */}
      {!open && shelf.items.length > 0 ? rows : null}
    </div>
  )
})

/**
 * "Woke", in the row's meta slot, for a chat whose snooze has run out.
 *
 * A woken chat comes back exactly where it was — the sidebar's order is
 * stable on purpose — so the pill is the only thing that says it is back, and
 * pressing it is one of the two ways to say "seen" (the other is opening the
 * chat). Amber because that is this sidebar's colour for something waiting on
 * the user, the same one the vendored status dot uses.
 */
export function WokePill({
  title,
  onDismiss,
}: {
  title: string
  onDismiss: () => void
}) {
  return (
    <button
      type="button"
      data-slot="sidebar-woke"
      title="Woke up — dismiss"
      aria-label={`Dismiss the wake notice on ${title}`}
      onClick={(event) => {
        // The row underneath is a select; dismissing is not opening.
        event.stopPropagation()
        onDismiss()
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm font-medium outline-none",
        "text-amber-600 hover:underline dark:text-amber-400",
        "focus-visible:ring-2 focus-visible:ring-sidebar-ring/60 [&_svg]:size-3"
      )}
    >
      <AlarmClock aria-hidden />
      <span role="status">Woke</span>
    </button>
  )
}

/**
 * The snooze control on a chat row: a popover of wake times.
 *
 * The presets are resolved when the popover *opens*, never at render — a
 * sidebar that has been sitting there since this morning would otherwise
 * offer an "in 1 hour" that has already passed, and "this evening" long after
 * the evening.
 */
export function SnoozeAction({
  title,
  onSnooze,
}: {
  title: string
  onSnooze: (until: number) => void
}) {
  // The clock is read in the open handler, never during render: the menu's
  // whole point is that "in 1 hour" means an hour from the moment it opened.
  const [openedAt, setOpenedAt] = React.useState(0)
  const presets = React.useMemo(
    () => (openedAt ? snoozePresets(openedAt) : []),
    [openedAt]
  )

  return (
    <Popover
      open={openedAt > 0}
      onOpenChange={(next) => setOpenedAt(next ? Date.now() : 0)}
    >
      <PopoverTrigger
        title="Snooze chat"
        aria-label={`Snooze ${title}`}
        className={SIDEBAR_ROW_ACTION}
      >
        <AlarmClock aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-56 p-1">
        <p className="px-2 py-1 text-[11px] text-muted-foreground">
          Snooze until
        </p>
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-slot="snooze-preset"
            title={`Wakes ${snoozeWakeDescription(preset.until, openedAt)}`}
            onClick={() => {
              setOpenedAt(0)
              onSnooze(preset.until)
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px]",
              "outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring/50"
            )}
          >
            <span className="min-w-0 flex-1 truncate">{preset.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {preset.when}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
