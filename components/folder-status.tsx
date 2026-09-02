"use client"

import { ArrowDown, ArrowUp, CircleDot, GitPullRequest } from "lucide-react"
import * as React from "react"

import * as api from "@/lib/api-client"
import { openExternal } from "@/lib/desktop"
import { cn } from "@/lib/utils"

/**
 * A folder section's git state, next to its branch: commits ahead and
 * behind the upstream, how many files are dirty, and the branch's pull
 * request when `gh` knows one. Polled — a sidebar cannot be told when a
 * commit lands — but gently: once a minute, on focus, and only for the
 * folders on screen.
 */

const POLL_MS = 60_000

type Status = api.GitStatus

/** One in-flight/last-known status per folder, shared by every mount. */
const cache = new Map<string, Status>()

/**
 * `sessionId` names a chat inside the folder — the route reads the folder
 * back from it, so the client never hands over a path; `cwd` only keys the
 * shared cache.
 */
export function useFolderStatus(cwd: string, sessionId: string) {
  const [status, setStatus] = React.useState<Status | null>(
    () => cache.get(cwd) ?? null
  )

  React.useEffect(() => {
    if (!cwd || !sessionId) return
    let cancelled = false
    const load = () => {
      if (document.hidden) return
      api
        .fetchGitStatus(sessionId)
        .then((next) => {
          if (cancelled) return
          cache.set(cwd, next)
          setStatus(next)
        })
        .catch(() => {
          /* the badge simply stays as it was */
        })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    window.addEventListener("focus", load)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener("focus", load)
    }
  }, [cwd, sessionId])

  return status
}

const chip =
  "inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 font-mono text-[10.5px] tabular-nums normal-case"

export const FolderStatus = React.memo(function FolderStatus({
  cwd,
  sessionId,
  className,
}: {
  cwd: string
  /** Any chat in the folder — the group's newest. */
  sessionId: string
  className?: string
}) {
  const status = useFolderStatus(cwd, sessionId)
  if (!status?.isGitRepo) return null
  const { ahead, behind, dirty, pr } = status
  if (!ahead && !behind && !dirty && !pr) return null

  return (
    <span
      data-slot="folder-status"
      className={cn("flex min-w-0 items-center gap-0.5", className)}
    >
      {ahead > 0 || behind > 0 ? (
        <span
          className={cn(chip, "text-muted-foreground")}
          title={`${ahead} ahead, ${behind} behind the upstream`}
        >
          {ahead > 0 ? (
            <>
              <ArrowUp className="size-2.5" />
              {ahead}
            </>
          ) : null}
          {behind > 0 ? (
            <>
              <ArrowDown className="size-2.5" />
              {behind}
            </>
          ) : null}
        </span>
      ) : null}
      {dirty > 0 ? (
        <span
          className={cn(chip, "text-amber-600 dark:text-amber-400")}
          title={`${dirty} uncommitted ${dirty === 1 ? "change" : "changes"}`}
        >
          <CircleDot className="size-2.5" />
          {dirty}
        </span>
      ) : null}
      {pr ? (
        <button
          type="button"
          data-state={pr.state.toLowerCase()}
          title={`#${pr.number} ${pr.title} · ${pr.state.toLowerCase()}`}
          onClick={(event) => {
            // The header it sits in is a disclosure; the click is ours.
            event.stopPropagation()
            void openExternal(pr.url)
          }}
          className={cn(
            chip,
            "outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50",
            pr.state === "OPEN"
              ? "text-emerald-600 dark:text-emerald-400"
              : pr.state === "MERGED"
                ? "text-violet-600 dark:text-violet-400"
                : "text-muted-foreground"
          )}
        >
          <GitPullRequest className="size-2.5" />#{pr.number}
        </button>
      ) : null}
    </span>
  )
})
