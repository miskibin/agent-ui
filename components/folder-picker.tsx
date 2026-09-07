"use client"

import { GitBranch, LoaderCircle } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { FolderPicker as RecentFolderPicker } from "@/components/ui/folder-picker"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import * as api from "@/lib/api-client"
import { errorMessage } from "@/lib/chat-helpers"
import { hasNativeFolderPicker, pickFolderNative } from "@/lib/desktop"
import { resolveAutoFeatureBranchName } from "@/lib/git-naming"
import type { SessionWorktree } from "@/lib/store/types"
import { cn } from "@/lib/utils"

/** What picking a folder produces. `worktree` is set only when one was made. */
export type FolderSelection = {
  cwd: string
  gitBranch: string
  /**
   * Provenance for a folder this picker just created — the repository it
   * belongs to and the branch it is on. Store it on the chat
   * (`SessionMeta.worktree`) so the sidebar can label the section and the
   * delete path can offer to clean the worktree up.
   */
  worktree?: SessionWorktree
}

export type FolderPickerProps = {
  cwd?: string
  gitBranch?: string
  /**
   * The chat's title. Only used to name the branch of a new worktree when the
   * user does not type one; without it the branch is a timestamp.
   */
  title?: string
  onChange: (next: FolderSelection) => void
  /** The header uses a quiet chip; an empty chat uses the bordered inline form. */
  variant?: "chip" | "inline"
  className?: string
}

/**
 * App adapter for the registry FolderPicker. The shared component owns the MRU
 * menu; this layer supplies persisted settings, git metadata, Tauri's native
 * directory dialog — and, beside it, the one thing a generic folder picker has
 * no business knowing about: git worktrees.
 *
 * **Why the worktree control lives here and not in the popover.** The shared
 * component is vendored from `chat-components` and must stay byte-identical to
 * upstream, so the affordance is *composed* next to it rather than added
 * inside it: a second chip that appears only when the chosen folder is a
 * checkout. That is also the honest shape for what it does — picking a folder
 * points the chat at something that exists, while this creates a branch and a
 * directory, which is a different kind of act and deserves its own button and
 * its own confirmation.
 */
export function FolderPicker({
  cwd,
  gitBranch,
  title,
  onChange,
  variant = "chip",
  className,
}: FolderPickerProps) {
  const [recents, setRecents] = React.useState<string[]>([])
  /**
   * The last folder a probe confirmed to be a checkout. Kept as the folder
   * itself rather than a boolean so the answer cannot outlive the question:
   * switching chats changes `cwd`, and a stale `true` would offer to branch a
   * repository the user is no longer looking at.
   */
  const [repoFolder, setRepoFolder] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const [branchDraft, setBranchDraft] = React.useState("")
  const [worktreeOpen, setWorktreeOpen] = React.useState(false)

  const loadRecents = React.useCallback(() => {
    void api
      .fetchSettings()
      .then((settings) => setRecents(settings.recentFolders))
      .catch(() => setRecents([]))
  }, [])

  const folder = cwd?.trim() ?? ""
  /** Is the chosen folder a checkout? Decides whether the chip is offered. */
  const isRepo = folder.length > 0 && repoFolder === folder

  // The picker learns a folder is a repo when the user picks it; a chat opened
  // with one already set has to ask. An answer that arrives after the folder
  // changed is simply for a different folder, and the comparison above drops
  // it — there is nothing to reset on the way out.
  React.useEffect(() => {
    if (!folder) return
    let current = true
    void api
      .fetchFolderInfo(folder)
      .then((info) => {
        if (current && info.exists && info.isDir && info.isGitRepo) {
          setRepoFolder(folder)
        }
      })
      .catch(() => {
        /* not a folder this app can read; no worktree offer for it */
      })
    return () => {
      current = false
    }
  }, [folder])

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

  /** Opening the form fills in the name the branch would get on its own. */
  const handleWorktreeOpenChange = React.useCallback(
    (open: boolean) => {
      setWorktreeOpen(open)
      if (open) setBranchDraft(resolveAutoFeatureBranchName(title))
    },
    [title]
  )

  const createWorktree = React.useCallback(() => {
    const repoRoot = folder
    if (!repoRoot || creating) return
    setCreating(true)
    void api
      .createWorktree({
        repoRoot,
        title,
        branch: branchDraft.trim() || undefined,
      })
      .then((worktree) => {
        setWorktreeOpen(false)
        onChange({ cwd: worktree.root, gitBranch: worktree.branch, worktree })
        toast.success(`Working in a new worktree on ${worktree.branch}`)
      })
      .catch((err: unknown) =>
        toast.error(errorMessage(err, "Could not create the worktree"))
      )
      .finally(() => setCreating(false))
  }, [branchDraft, creating, folder, onChange, title])

  const submitOnEnter = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return
      event.preventDefault()
      createWorktree()
    },
    [createWorktree]
  )

  return (
    <div
      data-slot="folder-picker-group"
      className="flex min-w-0 items-center gap-1"
    >
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
      {isRepo ? (
        <Popover open={worktreeOpen} onOpenChange={handleWorktreeOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-slot="new-worktree-trigger"
              data-variant={variant}
              title="Start this chat in a new git worktree"
              className={cn(
                "group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-muted data-[state=open]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
                variant === "inline" && "border border-dashed border-border/70"
              )}
            >
              <GitBranch className="size-3.5" />
              New worktree
            </button>
          </PopoverTrigger>
          <PopoverContent
            data-slot="new-worktree-content"
            align="start"
            side={variant === "inline" ? "top" : "bottom"}
            sideOffset={8}
            collisionPadding={12}
            className="w-[min(22rem,calc((100vw-1.5rem)/var(--ui-scale,1)))] p-3"
          >
            <div className="flex flex-col gap-2">
              <div className="text-[12px] font-medium">New worktree</div>
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                A second checkout of this repository, on its own branch, so this
                chat can work beside the others without sharing files.
              </p>
              <Input
                autoFocus
                value={branchDraft}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setBranchDraft(event.target.value)}
                onKeyDown={submitOnEnter}
                placeholder="Branch name"
                aria-label="Branch name"
                className="h-8 text-[12.5px]"
              />
              <Button
                size="sm"
                disabled={creating}
                onClick={createWorktree}
                className="h-8 text-[12.5px]"
              >
                {creating ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <GitBranch className="size-3.5" />
                )}
                {creating ? "Creating…" : "Create worktree"}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}
