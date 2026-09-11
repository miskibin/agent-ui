"use client"

import { FileWarning, GitCompare, PanelLeft, RefreshCw, X } from "lucide-react"
import * as React from "react"

import { CommitControl } from "@/components/commit-control"
import { refreshFolderStatus, useFolderStatus } from "@/components/folder-status"
import type { FileActionItem } from "@/components/ui/change-summary"
import { DiffStack, type DiffStackFile } from "@/components/ui/diff-view"
import {
  FileTree,
  type FileTreeEntry,
  type FileTreeStatus,
} from "@/components/ui/file-tree"
import * as api from "@/lib/api-client"
import { cn } from "@/lib/utils"

/**
 * Everything the chat changed, read the way a review is read: one column of
 * diffs, one scrollbar, top to bottom.
 *
 * The file map is a hideable sidebar beside that column — the same shape as
 * opening a file next to its tree — so hiding it gives the diffs the width,
 * and clicking a row still scrolls the stack rather than replacing it.
 *
 * The single scroller is the load-bearing part, and it is why the diffs are one
 * vendored `DiffStack` rather than a column of `DiffView`s: `@pierre/diffs`
 * virtualizes every file against one container, so the wheel never hits a
 * boundary halfway down the review and a hundred-file change costs what one
 * screen costs.
 */

/** The file map starts open; a review usually begins by looking at the list. */
const MAP_OPEN_DEFAULT = true

/** Git's own letters on a patch, as the tree's status names. */
function treeStatus(letter: string): FileTreeStatus {
  if (letter === "A") return "added"
  if (letter === "D") return "deleted"
  if (letter === "?") return "untracked"
  return "modified"
}

export function ChangesPanel({
  sessionId,
  cwd,
  onClose,
  onOpenFile,
  fileActions,
  className,
}: {
  sessionId: string
  cwd: string
  onClose?: () => void
  /** A map row's "open on its own" — hands the path to the file panel. */
  onOpenFile?: (path: string) => void
  /** Right-click menu on the browser's rows, as everywhere else. */
  fileActions?: FileActionItem[]
  className?: string
}) {
  const status = useFolderStatus(cwd, sessionId)
  const [files, setFiles] = React.useState<api.ChangedFilePatch[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [mapOpen, setMapOpen] = React.useState(MAP_OPEN_DEFAULT)
  const [focus, setFocus] = React.useState<{ path: string; nonce: number } | null>(
    null
  )
  /**
   * The map has two jobs, and they are not the same job. "Changed" indexes the
   * stack beside it — a row scrolls to that file rather than replacing anything.
   * "Browse folder" is the old popover's other half, kept because a review is
   * also when you want to open the file *next* to the one that changed; its
   * rows open in the file panel, which is what that panel is for.
   */
  const [browsing, setBrowsing] = React.useState(false)

  /**
   * Re-read the worktree.
   *
   * The spinner is raised in a microtask rather than inline: this runs from an
   * effect, and a synchronous `setState` in an effect body is the one thing the
   * hooks rules forbid outright.
   */
  const load = React.useCallback(() => {
    if (!sessionId) return
    queueMicrotask(() => setLoading(true))
    api
      .fetchChangedFiles(sessionId)
      .then((next) => {
        setFiles(next)
        setError(null)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not read the changes")
      })
      .finally(() => setLoading(false))
  }, [sessionId])

  /**
   * On open, and again whenever the worktree moves. A commit from the control
   * below empties the list and a turn that just wrote files fills it — both go
   * through `refreshFolderStatus`, which `useFolderStatus` already listens to,
   * so the dirty count changing is the signal to ask again.
   */
  const dirty = status?.dirty
  React.useEffect(() => {
    load()
  }, [dirty, load])

  const stack = React.useMemo<DiffStackFile[]>(
    () =>
      (files ?? [])
        .filter((file) => !file.binary && file.patch)
        .map((file) => ({ path: file.path, patch: file.patch })),
    [files]
  )

  const dirtyPaths = React.useMemo(
    () => (files ?? []).map((file) => file.path),
    [files]
  )

  const treeEntries = React.useMemo<FileTreeEntry[]>(
    () =>
      (files ?? []).map((file) => ({
        path: file.path,
        status: treeStatus(file.status),
        additions: file.insertions,
        deletions: file.deletions,
      })),
    [files]
  )

  const reveal = React.useCallback((path: string) => {
    setFocus((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [])

  const loadChildren = React.useCallback(
    async (dir: string) => {
      if (!sessionId) return []
      try {
        const { entries } = await api.listFolderLevel(sessionId, dir)
        return entries
      } catch {
        // A level that could not be read stays closed rather than empty; the
        // tree asks again the next time it is opened.
        return []
      }
    },
    [sessionId]
  )

  const refresh = React.useCallback(() => {
    refreshFolderStatus(cwd)
    load()
  }, [cwd, load])

  return (
    <aside
      data-slot="changes-panel"
      aria-label="Changes in this chat"
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
    >
      <header
        data-slot="changes-panel-header"
        className="flex h-10 shrink-0 items-center gap-1.5 border-b px-2.5 text-[13px]"
      >
        <GitCompare className="size-3.5 shrink-0 opacity-70" />
        <span className="shrink-0 font-medium text-foreground">Changes</span>
        {files ? (
          <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
            {files.length}
          </span>
        ) : null}
        {status?.branch ? (
          <span
            className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground"
            title={status.branch}
          >
            {status.branch}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <button
          type="button"
          data-slot="changes-panel-tree-toggle"
          aria-expanded={mapOpen}
          aria-label={mapOpen ? "Hide the file tree" : "Show the file tree"}
          title={mapOpen ? "Hide the file tree" : "Show the file tree"}
          onClick={() => setMapOpen((open) => !open)}
          className={ICON_BUTTON}
        >
          <PanelLeft />
        </button>
        <button
          type="button"
          data-slot="changes-panel-refresh"
          aria-label="Re-read the changes"
          title="Re-read the changes"
          onClick={refresh}
          className={ICON_BUTTON}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </button>
        {onClose ? (
          <button
            type="button"
            data-slot="changes-panel-close"
            aria-label="Close the changes"
            title="Close the changes"
            onClick={onClose}
            className={ICON_BUTTON}
          >
            <X />
          </button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        {mapOpen ? (
          <div
            data-slot="changes-panel-map"
            className="flex w-[13.75rem] shrink-0 flex-col border-r"
          >
            <div
              role="group"
              aria-label="File list scope"
              className="flex shrink-0 items-center gap-0.5 px-2 py-1.5"
            >
              <button
                type="button"
                data-active={!browsing}
                onClick={() => setBrowsing(false)}
                className={SCOPE}
              >
                Changed
              </button>
              <button
                type="button"
                data-active={browsing}
                onClick={() => setBrowsing(true)}
                className={SCOPE}
              >
                Browse
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {browsing && cwd ? (
                <FileTree
                  loadChildren={loadChildren}
                  initialExpansion="closed"
                  onSelect={(path) => onOpenFile?.(path)}
                  fileActions={fileActions}
                  label="Folder"
                  searchPlaceholder="Filter loaded files"
                  emptyLabel="Nothing to browse here."
                  className="h-full"
                />
              ) : (
                <FileTree
                  entries={treeEntries}
                  selectedPath={focus?.path}
                  revealNonce={focus?.nonce}
                  onSelect={reveal}
                  fileActions={fileActions}
                  label="Changed files"
                  search={false}
                  emptyLabel={
                    files === null
                      ? "Reading the worktree…"
                      : "Nothing has changed in this folder yet."
                  }
                  className="h-full"
                />
              )}
            </div>
          </div>
        ) : null}

        <div data-slot="changes-panel-body" className="min-h-0 min-w-0 flex-1">
          {error ? (
            <p className="flex items-start gap-1.5 px-3 py-2 text-[12.5px] text-muted-foreground">
              <FileWarning aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : (
            <DiffStack
              files={stack}
              focusPath={focus?.path}
              focusNonce={focus?.nonce}
              emptyLabel={
                files === null
                  ? "Reading the worktree…"
                  : files.length
                    ? "Every change here is binary or too large to show."
                    : "Nothing has changed in this folder yet."
              }
              className="h-full"
            />
          )}
        </div>
      </div>

      {status?.isGitRepo ? (
        <CommitControl sessionId={sessionId} cwd={cwd} paths={dirtyPaths} />
      ) : null}
    </aside>
  )
}

const SCOPE =
  "rounded-md px-2 py-0.5 text-[11.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[active=true]:bg-muted data-[active=true]:text-foreground"

const ICON_BUTTON =
  "inline-grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3.5"
