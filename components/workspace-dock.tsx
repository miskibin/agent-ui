"use client"

import { Code, FileDiff, FolderOpen, GitBranch } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"
import * as api from "@/lib/api-client"
import { folderName } from "@/lib/folder"
import type { ChangeSummaryFile } from "@/components/ui/change-summary"
import {
  useFolderStatus,
  refreshFolderStatus,
  pollable,
} from "@/components/folder-status"

/** Project actions and background activity share one anchored workspace surface. */
export function WorkspaceDock({
  sessionId,
  cwd,
  branch,
  files,
  running,
  onChanges,
  children,
}: {
  sessionId: string
  cwd?: string
  branch?: string
  files: ChangeSummaryFile[]
  running: boolean
  onChanges: () => void
  children: React.ReactNode
}) {
  const status = useFolderStatus(cwd || "", sessionId)
  React.useEffect(() => {
    if (!cwd || !sessionId || !running) return
    const timer = setInterval(() => {
      if (pollable()) refreshFolderStatus(cwd)
    }, 3000)
    return () => clearInterval(timer)
  }, [cwd, sessionId, running])
  const additions =
    status?.insertions ??
    files.reduce((total, file) => total + (file.additions ?? 0), 0)
  const deletions =
    status?.deletions ??
    files.reduce((total, file) => total + (file.deletions ?? 0), 0)
  const open = (action: "editor" | "reveal") => {
    if (cwd)
      void api
        .openPath({ action, path: cwd })
        .catch((error) =>
          toast.error(
            error instanceof Error ? error.message : "Could not open project"
          )
        )
  }
  const row =
    "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[12px] transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
  return (
    <section
      data-slot="workspace-dock"
      aria-label="Workspace"
      className="overflow-hidden rounded-2xl border border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground shadow-sm"
    >
      <div className="p-1.5">
        <button
          type="button"
          className={row}
          onClick={() => open("reveal")}
          disabled={!cwd}
          title={cwd}
        >
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-semibold">
            {cwd ? folderName(cwd) : "No project selected"}
          </span>
        </button>
        <button
          type="button"
          className={row}
          onClick={() => open("editor")}
          disabled={!cwd}
        >
          <Code className="size-4 shrink-0 text-muted-foreground" />
          Open in editor
        </button>
      </div>
      <div className="border-t border-sidebar-border p-1.5">
        <div className="flex items-center gap-2.5 px-3 py-2 text-[12px]">
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {status?.branch || branch || "No branch selected"}
          </span>
        </div>
        <button
          type="button"
          className={row}
          onClick={onChanges}
          aria-label="Review workspace changes"
        >
          <FileDiff className="size-4 shrink-0 text-muted-foreground" />
          <span>Review &amp; commit</span>
          <span className="ml-auto flex gap-2 font-mono text-[11px] tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{additions.toLocaleString()}
            </span>
            <span className="text-red-600 dark:text-red-400">
              −{deletions.toLocaleString()}
            </span>
          </span>
        </button>
      </div>
      <div className="empty:hidden [&:has(>details)]:border-t [&:has(>details)]:border-sidebar-border">
        {children}
      </div>
    </section>
  )
}
