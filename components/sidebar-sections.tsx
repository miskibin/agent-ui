"use client"

import * as React from "react"

import { FolderStatus } from "@/components/folder-status"
import {
  ChatSidebarItemList,
  SidebarCollapsibleSection,
  SidebarItemBadge,
  SidebarItemStatusDot,
  type ChatSidebarItemData,
  type SidebarItemMenuAction,
} from "@/components/ui/chat-sidebar"
import type { SessionGroup } from "@/lib/session-groups"

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
}

export const SidebarSessionSection = React.memo(function SidebarSessionSection({
  id,
  title,
  action,
  sortable = false,
  open,
  onToggle,
  sessions,
  ...rest
}: SidebarSectionProps & {
  id: string
  title: React.ReactNode
  /** Rendered at the right edge of the header, before the count. */
  action?: React.ReactNode
  /** Hand-made order — only the pinned group has one to keep. */
  sortable?: boolean
  sessions: ChatSidebarItemData[]
}) {
  const toggle = React.useCallback(() => onToggle(id), [id, onToggle])
  return (
    <SidebarCollapsibleSection
      title={title}
      open={open}
      onToggle={toggle}
      action={action}
      count={sessions.length}
    >
      <ChatSidebarItemList
        items={sessions}
        activeId={rest.activeId}
        listId={id}
        renameRequest={rest.renameRequest}
        sortable={sortable}
        draggable
        onSelect={rest.onSelect}
        onRename={rest.onRename}
        onTogglePin={rest.onTogglePin}
        onDelete={rest.onDelete}
        onDeleteMany={rest.onDeleteMany}
        getMenuActions={rest.getMenuActions}
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
      title={<span title={group.cwd || undefined}>{group.label}</span>}
      action={
        <span className="flex min-w-0 items-center gap-1.5 normal-case">
          {group.branch ? (
            <SidebarItemBadge branch={group.branch} className="min-w-0" />
          ) : null}
          {group.cwd && group.items[0] ? (
            <FolderStatus cwd={group.cwd} sessionId={group.items[0].id} />
          ) : null}
          {group.running && !open ? (
            <SidebarItemStatusDot status="streaming" />
          ) : null}
        </span>
      }
      sessions={group.items}
    />
  )
})
