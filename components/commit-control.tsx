"use client"

import { GitCommitVertical, Loader2, Upload } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { refreshFolderStatus } from "@/components/folder-status"
import * as api from "@/lib/api-client"

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
