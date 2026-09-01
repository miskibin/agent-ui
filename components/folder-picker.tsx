"use client"

import * as React from "react"
import { toast } from "sonner"

import { FolderPicker as RecentFolderPicker } from "@/components/ui/folder-picker"
import * as api from "@/lib/api-client"
import { hasNativeFolderPicker, pickFolderNative } from "@/lib/desktop"

export type FolderPickerProps = {
  cwd?: string
  gitBranch?: string
  onChange: (next: { cwd: string; gitBranch: string }) => void
  /** The header uses a quiet chip; an empty chat uses the bordered inline form. */
  variant?: "chip" | "inline"
  className?: string
}

/**
 * App adapter for the registry FolderPicker. The shared component owns the MRU
 * menu; this layer supplies persisted settings, git metadata, and Tauri's
 * native directory dialog.
 */
export function FolderPicker({
  cwd,
  gitBranch,
  onChange,
  variant = "chip",
  className,
}: FolderPickerProps) {
  const [recents, setRecents] = React.useState<string[]>([])

  const loadRecents = React.useCallback(() => {
    void api
      .fetchSettings()
      .then((settings) => setRecents(settings.recentFolders))
      .catch(() => setRecents([]))
  }, [])

  const selectFolder = React.useCallback(
    async (path: string) => {
      try {
        const info = await api.fetchFolderInfo(path)
        if (!info.exists || !info.isDir) {
          toast.error("That folder is no longer available.")
          loadRecents()
          return
        }

        const nextBranch = info.isGitRepo
          ? gitBranch && info.branches.includes(gitBranch)
            ? gitBranch
            : info.currentBranch
          : ""

        onChange({ cwd: info.path, gitBranch: nextBranch })
        void api
          .rememberFolder(info.path)
          .then((settings) => setRecents(settings.recentFolders))
          .catch(() => toast.error("Couldn't update the recent folders."))
      } catch {
        toast.error("That folder couldn't be opened.")
      }
    },
    [gitBranch, loadRecents, onChange]
  )

  const pickRecent = React.useCallback(
    (path: string) => {
      void selectFolder(path)
    },
    [selectFolder]
  )

  const openFolder = React.useCallback(async () => {
    if (!hasNativeFolderPicker()) {
      toast.error("Open Folder is available in the desktop app.")
      return
    }

    try {
      const path = await pickFolderNative(cwd)
      if (path) await selectFolder(path)
    } catch {
      toast.error("The system folder chooser didn't open.")
    }
  }, [cwd, selectFolder])

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (open) loadRecents()
    },
    [loadRecents]
  )

  return (
    <RecentFolderPicker
      value={cwd}
      recents={recents}
      detail={gitBranch || undefined}
      onChange={pickRecent}
      onOpenFolder={openFolder}
      onOpenChange={handleOpenChange}
      placeholder={variant === "chip" ? "Choose folder" : "Choose a working folder"}
      side={variant === "inline" ? "top" : "bottom"}
      variant={variant}
      className={className}
    />
  )
}
