"use client"

import { GitCommitVertical, Loader2, Upload } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { refreshFolderStatus } from "@/components/folder-status"
import * as api from "@/lib/api-client"
import { cn } from "@/lib/utils"

/**
 * Committing what the chat produced, wherever the changes are being looked at.
 *
 * Lives on its own because there are now two of those: the header popover's
 * file tree, and the changes panel beside the conversation. One control, so
 * the two can never disagree about what an empty message means or which paths
 * a commit would stage.
 */

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
export function CommitControl({
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
      className="shrink-0 border-t px-2 py-2"
    >
      <div
        data-slot="chat-changes-commit-surface"
        className="rounded-lg border bg-muted/40 px-2 pt-1.5 pb-1.5 has-[textarea:focus]:border-ring dark:bg-muted/25"
      >
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void commit()
            }
          }}
          rows={2}
          placeholder="Message — empty writes one from the diff"
          aria-label="Commit message"
          className="w-full resize-none bg-transparent px-0.5 py-0.5 text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {paths.length
              ? `${paths.length} ${paths.length === 1 ? "file" : "files"}`
              : "Nothing to commit"}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void push()}
              title="Push this branch to its remote"
              className={cn(COMMIT_BTN, "text-muted-foreground hover:bg-background hover:text-foreground")}
            >
              {busy === "push" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              Push
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void commit()}
              title="Commit (Ctrl+Enter)"
              className={cn(
                COMMIT_BTN,
                "bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-primary/15 disabled:text-primary/70 disabled:opacity-100"
              )}
            >
              {busy === "commit" ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  {message.trim() ? "Committing" : "Writing"}
                </>
              ) : (
                <>
                  <GitCommitVertical className="size-3.5" />
                  Commit
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const COMMIT_BTN =
  "inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-[12px] font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-60"
