"use client"

import { FileDiff, GitCommitVertical, Loader2, Upload } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { AppHeaderButton } from "@/components/app-header"
import { refreshFolderStatus, useFolderStatus } from "@/components/folder-status"
import {
  fileChangesFromTools,
  type ChangeSummaryFile,
  type FileActionItem,
} from "@/components/ui/change-summary"
import { FileTree, type FileTreeEntry } from "@/components/ui/file-tree"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import * as api from "@/lib/api-client"
import { toolsFromParts } from "@/lib/message-stream"
import type { StoredMessage } from "@/lib/store/types"
import { cn } from "@/lib/utils"

/**
 * Every file the chat has changed, across all of its turns — the "whole
 * thread" scope next to the per-turn card under each answer. Lives in the
 * header as a count; opens a tree of those files, so a row here opens the
 * same panel and carries the same right-click menu.
 */

/**
 * Union of every settled turn's change card, stats summed per path. A turn
 * carries an explicit `changes` list only when `lib/turn-files` had something
 * to add; otherwise its card is derived here the way `Message` derives it, so
 * the two never disagree — including the one thing that outranks both, the
 * turn's own worktree checkpoint (`lib/checkpoints`), which is a measured diff
 * rather than a claim made by a tool call.
 */
const derivedChanges = new WeakMap<StoredMessage, ChangeSummaryFile[]>()

/** A settled message's list, parsed once: the union is rebuilt per frame. */
function changesOf(message: StoredMessage): ChangeSummaryFile[] {
  if (message.changes) return message.changes
  const cached = derivedChanges.get(message)
  if (cached) return cached
  const measured = message.metadata?.checkpoint?.files
  const changes = measured
    ? measured.map((file) => ({
        path: file.path,
        additions: file.insertions,
        deletions: file.deletions,
      }))
    : fileChangesFromTools(
        message.tools?.length ? message.tools : toolsFromParts(message.parts ?? [])
      )
  derivedChanges.set(message, changes)
  return changes
}

export function collectChatChanges(messages: StoredMessage[]): ChangeSummaryFile[] {
  const byPath = new Map<string, ChangeSummaryFile>()
  for (const message of messages) {
    if (message.sender !== "assistant") continue
    for (const change of changesOf(message)) {
      const existing = byPath.get(change.path)
      if (existing) {
        existing.additions = (existing.additions ?? 0) + (change.additions ?? 0)
        existing.deletions = (existing.deletions ?? 0) + (change.deletions ?? 0)
      } else {
        byPath.set(change.path, { ...change })
      }
    }
  }
  return [...byPath.values()]
}

/**
 * The folder's own dirty files, as the sidebar's poller already has them, plus
 * the ones only the transcript knows about.
 *
 * Git is the honest half — it measured the worktree — but it only ever answers
 * about a checkout, and a chat's card also names files a turn merely produced.
 * So git's rows come first, with their real counts, and a change the transcript
 * carries is appended when git has no row for that path.
 */
function mergeChangedFiles(
  fromGit: readonly { path: string; insertions: number; deletions: number }[],
  fromChat: readonly ChangeSummaryFile[],
  cwd: string | undefined
): FileTreeEntry[] {
  const entries: FileTreeEntry[] = fromGit.map((file) => ({
    path: file.path,
    // `git status` names the file but not what happened to it; a row with
    // lines on it is a modification, and a 0/0 row (an untracked file, a mode
    // change) is left uncoloured rather than guessed at.
    ...(file.insertions + file.deletions > 0
      ? { status: "modified" as const }
      : null),
    additions: file.insertions,
    deletions: file.deletions,
  }))
  const seen = new Set(entries.map((entry) => entry.path))
  for (const change of fromChat) {
    const relative = repoRelative(change.path, cwd)
    if (seen.has(relative)) continue
    seen.add(relative)
    entries.push({
      path: relative,
      additions: change.additions,
      deletions: change.deletions,
    })
  }
  return entries
}

/**
 * A tool names a file however it thought of it; git always answers relative to
 * the checkout. Folding the chat's spelling onto git's is what keeps one file
 * from appearing twice in the tree.
 */
function repoRelative(path: string, cwd: string | undefined) {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "")
  const root = cwd?.replace(/\\/g, "/").replace(/\/+$/, "")
  if (!root) return normalized
  const windows = /^[A-Za-z]:/.test(root)
  const inside = windows
    ? normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : normalized.startsWith(`${root}/`)
  return inside ? normalized.slice(root.length + 1) : normalized
}

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * What a failed push failed of, read back off git's own words.
 *
 * The route classifies it server-side and answers with a `kind`, but the
 * client's error path only carries the message — so the same few phrases are
 * matched again here (`lib/git-commit.ts` holds the original). It only picks
 * the offer the toast makes: "sign in" and "pull first" are different problems,
 * and neither is the "try again" a bare failure would suggest.
 */
function pushFailureHint(message: string) {
  const text = message.toLowerCase()
  if (
    text.includes("authentication failed") ||
    text.includes("could not read username") ||
    text.includes("could not read password") ||
    text.includes("terminal prompts disabled") ||
    text.includes("permission denied (publickey)") ||
    text.includes("access denied") ||
    text.includes("403") ||
    text.includes("invalid username or token")
  ) {
    return "Not signed in to the remote — authenticate with `gh auth login`, or add an SSH key."
  }
  if (
    text.includes("non-fast-forward") ||
    text.includes("fetch first") ||
    text.includes("[rejected]") ||
    text.includes("updates were rejected")
  ) {
    return "The remote has commits this branch does not — pull (or rebase) first, then push again."
  }
  if (
    text.includes("does not appear to be a git repository") ||
    text.includes("no such remote") ||
    text.includes("could not read from remote repository")
  ) {
    return "This folder has no remote to push to — add an `origin` first."
  }
  return message
}

/** `a1b2c3d` — the length a person reads a commit by. */
function shortSha(sha: string) {
  return sha.slice(0, 7)
}

/**
 * Commit what the chat changed, and push it.
 *
 * The message is the part worth caring about, and the route writes one from
 * the staged diff when it is not given one — so the textarea is empty by
 * default and says so: typing in it takes over, leaving it alone asks for one
 * to be written. The route has no dry run, so there is no generated message to
 * show before the commit lands; the toast that follows names the subject that
 * did.
 *
 * Committing onto the repository's trunk is answered rather than refused: the
 * route hands back the message it wrote, and the confirmation calls again with
 * that same message, so the commit that lands is the one the question was
 * about.
 */
function CommitControl({
  sessionId,
  cwd,
  paths,
}: {
  sessionId: string
  cwd: string
  /** The dirty files to stage — everything in the tree git knows about. */
  paths: string[]
}) {
  const [message, setMessage] = React.useState("")
  const [busy, setBusy] = React.useState<"commit" | "push" | null>(null)
  const busyRef = React.useRef<"commit" | "push" | null>(null)
  React.useEffect(() => {
    busyRef.current = busy
  }, [busy])

  /**
   * Plain functions rather than callbacks: they only ever reach an `onClick`
   * on this un-memoized control, and the confirmation path calls back into
   * `commit` — which a `useCallback` cannot do without reading itself before
   * it exists.
   */
  async function commit(confirmed?: { message: string }) {
    if (busyRef.current) return
    busyRef.current = "commit"
    setBusy("commit")
    try {
      const typed = message.trim()
      const result = await api.commitChanges({
        sessionId,
        ...(paths.length ? { paths } : null),
        // The confirmation answers a question about a message that was already
        // written, so it goes back exactly as it came — no second completion,
        // and no differently worded commit than the one that was agreed to.
        ...(confirmed
          ? { message: confirmed.message, allowDefaultBranch: true }
          : typed
            ? { message: typed }
            : null),
      })
      if ("needsConfirmation" in result) {
        const branch = result.branch || "the default branch"
        toast.warning(`Commit straight to ${branch}?`, {
          description: `${result.subject} — ${branch} is this repository's default branch.`,
          duration: 10_000,
          action: {
            label: `Commit to ${branch}`,
            onClick: () => void commit({ message: result.message }),
          },
        })
        return
      }
      setMessage("")
      toast.success(result.subject, { description: shortSha(result.sha) })
      // The worktree just stopped being dirty; the sidebar badge and this tree
      // both read `/api/git/status`.
      refreshFolderStatus(cwd)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not commit those changes"
      )
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  async function push() {
    if (busyRef.current) return
    busyRef.current = "push"
    setBusy("push")
    try {
      const result = await api.pushChanges(sessionId)
      toast.success(
        result.created
          ? `Pushed ${result.branch} and set its upstream`
          : `Pushed ${result.branch}`
      )
      refreshFolderStatus(cwd)
    } catch (error) {
      const raw =
        error instanceof Error ? error.message : "Could not push this branch"
      toast.error("Push failed", {
        description: pushFailureHint(raw),
        duration: 8_000,
      })
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  return (
    <div
      data-slot="chat-changes-commit"
      className="flex shrink-0 flex-col gap-1.5 border-t p-2"
    >
      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        rows={2}
        placeholder="Commit message — empty writes one from the diff"
        aria-label="Commit message"
        className="w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void commit()}
          className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 text-[12px] font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
        >
          {busy === "commit" ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              {message.trim() ? "Committing" : "Writing a message"}
            </>
          ) : (
            <>
              <GitCommitVertical className="size-3.5" />
              Commit
            </>
          )}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void push()}
          title="Push this branch to its remote"
          className="inline-flex h-7 items-center justify-center gap-1 rounded-md border px-2 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
        >
          {busy === "push" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Upload className="size-3.5" />
          )}
          Push
        </button>
      </div>
    </div>
  )
}

const TOGGLE =
  "rounded-md px-2 py-0.5 text-[11.5px] outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-xs"

export function ChatChanges({
  files,
  fileActions,
  onFileClick,
  sessionId,
  cwd,
  selectedPath,
}: {
  files: ChangeSummaryFile[]
  fileActions?: FileActionItem[]
  onFileClick: (file: ChangeSummaryFile) => void
  /** The open chat — the folder browser resolves its root from this. */
  sessionId: string
  /** The chat's folder, for folding absolute paths onto git's spelling. */
  cwd?: string
  /** The file the panel is showing, kept selected in the tree. */
  selectedPath?: string | null
}) {
  const [open, setOpen] = React.useState(false)
  const close = React.useCallback(() => setOpen(false), [])

  // The pending line comments render themselves into the composer's own
  // wrapper; they are mounted from here only because this is the one control
  // the chat surface always has on screen. Nothing else about them is this
  // component's business, and the natural home is `app/page.tsx`, beside the
  // composer they belong to.
  if (files.length === 0) return null

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <AppHeaderButton
            label={`${files.length} ${files.length === 1 ? "file" : "files"} changed in this chat`}
          >
            <FileDiff />
            <span className="text-[11px] tabular-nums">{files.length}</span>
          </AppHeaderButton>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 p-0">
          {/* Mounted only while the popover is open: the tree measures its own
              container to virtualize, and a hidden one measures zero. */}
          {open ? (
            <ChatChangesTree
              files={files}
              fileActions={fileActions}
              onFileClick={onFileClick}
              onClose={close}
              sessionId={sessionId}
              cwd={cwd}
              selectedPath={selectedPath}
            />
          ) : null}
        </PopoverContent>
      </Popover>
    </>
  )
}

/**
 * The popover's body: the chat's changed files as a tree, and — for a chat
 * with a folder — the folder itself, one level at a time.
 */
function ChatChangesTree({
  files,
  fileActions,
  onFileClick,
  onClose,
  sessionId,
  cwd,
  selectedPath,
}: {
  files: ChangeSummaryFile[]
  fileActions?: FileActionItem[]
  onFileClick: (file: ChangeSummaryFile) => void
  onClose: () => void
  sessionId: string
  cwd?: string
  selectedPath?: string | null
}) {
  const [browsing, setBrowsing] = React.useState(false)
  const status = useFolderStatus(cwd ?? "", cwd ? sessionId : "")
  const entries = React.useMemo(
    () => mergeChangedFiles(status?.files ?? [], files, cwd),
    [cwd, files, status?.files]
  )
  const selected = React.useMemo(
    () => (selectedPath ? repoRelative(selectedPath, cwd) : null),
    [cwd, selectedPath]
  )
  /**
   * What a commit would stage: git's own dirty list, never the transcript's.
   * A path only the chat named may not exist on disk any more, and `git add`
   * on a pathspec that matches nothing fails the whole staging step.
   */
  const dirtyPaths = React.useMemo(
    () => (status?.files ?? []).map((file) => file.path),
    [status?.files]
  )

  /**
   * A tree row is a path; the card row it came from carries the stats and the
   * spelling the transcript used, which is what reaches back into the turn for
   * the tool that wrote the file. Fall back to the bare path for a file only
   * git or the browser knows about.
   */
  const select = React.useCallback(
    (path: string) => {
      onClose()
      const match = files.find((file) => repoRelative(file.path, cwd) === path)
      onFileClick(match ?? { path })
    },
    [cwd, files, onClose, onFileClick]
  )

  /** One level of the chat's folder, asked for the first time it is opened. */
  const loadChildren = React.useCallback(
    async (dir: string) => {
      if (!sessionId) return []
      try {
        const { entries: level } = await api.listFolderLevel(sessionId, dir)
        return level
      } catch {
        // A level that could not be read stays closed rather than empty; the
        // tree asks again the next time it is opened.
        return []
      }
    },
    [sessionId]
  )

  return (
    <div className="flex h-80 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        {/* "Changed files", not "changed in this chat": the tree is the union
            of what the turns did and what the worktree still holds, and a
            file the user edited themselves belongs in it. */}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
          Changed files
        </span>
        {cwd ? (
          <div
            role="group"
            aria-label="File list scope"
            className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5 text-muted-foreground"
          >
            <button
              type="button"
              data-active={!browsing}
              onClick={() => setBrowsing(false)}
              className={cn(TOGGLE)}
            >
              Changed
            </button>
            <button
              type="button"
              data-active={browsing}
              onClick={() => setBrowsing(true)}
              className={cn(TOGGLE)}
            >
              Browse folder
            </button>
          </div>
        ) : null}
      </div>
      {browsing && cwd ? (
        <FileTree
          key="browse"
          loadChildren={loadChildren}
          initialExpansion="closed"
          selectedPath={selected}
          onSelect={select}
          fileActions={fileActions}
          label="Folder"
          searchPlaceholder="Filter loaded files"
          emptyLabel="Nothing to browse here."
        />
      ) : (
        <FileTree
          key="changed"
          entries={entries}
          selectedPath={selected}
          onSelect={select}
          fileActions={fileActions}
          label="Changed files"
          searchPlaceholder="Filter changed files"
          emptyLabel="No files changed yet."
        />
      )}
      {cwd && status?.isGitRepo ? (
        <CommitControl sessionId={sessionId} cwd={cwd} paths={dirtyPaths} />
      ) : null}
    </div>
  )
}
