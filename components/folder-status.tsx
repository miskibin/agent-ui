"use client"

import { ArrowDown, ArrowUp, CircleDot, Globe, GitPullRequest } from "lucide-react"
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

/** Every mounted reader of one folder, so a write to disk can wake them. */
const listeners = new Map<string, Set<() => void>>()

/**
 * Re-read one folder's git state now, in every component showing it.
 *
 * The poll is once a minute, which is right for a commit landing in another
 * window and wrong for something this app just did: restoring a checkpoint
 * rewrites the worktree, and the sidebar badge and the changed-files tree
 * would otherwise keep describing the tree from before it.
 */
export function refreshFolderStatus(cwd: string) {
  for (const listener of listeners.get(cwd) ?? []) listener()
}

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
    const forFolder = listeners.get(cwd) ?? new Set<() => void>()
    forFolder.add(load)
    listeners.set(cwd, forFolder)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener("focus", load)
      forFolder.delete(load)
      if (forFolder.size === 0) listeners.delete(cwd)
    }
  }, [cwd, sessionId])

  return status
}

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/** A dev server comes and goes with a command; the branch state does not. */
const DEV_SERVER_POLL_MS = 30_000

const NO_SERVERS: api.DevServer[] = []

/** Last answer per chat, so a header that remounts does not blink empty. */
const devServers = new Map<string, api.DevServer[]>()
/** One request per chat at a time: the scan behind it walks the machine. */
const devServerProbes = new Map<string, Promise<api.DevServer[]>>()

function probeDevServers(sessionId: string) {
  const running = devServerProbes.get(sessionId)
  if (running) return running
  const probe = api
    .fetchDevServers(sessionId)
    .then((servers) => {
      devServers.set(sessionId, servers)
      return servers
    })
    .finally(() => {
      devServerProbes.delete(sessionId)
    })
  devServerProbes.set(sessionId, probe)
  return probe
}

/**
 * The local dev servers running for this folder.
 *
 * An agent told to "start the dev server" leaves a listener behind and says so
 * in prose; `GET /api/dev-servers` looks instead — which ports answer with a
 * page — so the folder header can offer the thing itself. Polled on its own
 * cadence rather than with the git state: a server appears seconds after a
 * command runs, and a minute of a header not mentioning it is a minute of the
 * user going looking in the transcript.
 *
 * Everything about it is best-effort: a failed probe leaves the last answer
 * standing, and a hidden window asks for nothing at all.
 */
export function useDevServers(sessionId: string) {
  const [servers, setServers] = React.useState<api.DevServer[]>(
    () => devServers.get(sessionId) ?? NO_SERVERS
  )

  React.useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const load = () => {
      if (document.hidden) return
      probeDevServers(sessionId)
        .then((next) => {
          if (!cancelled) setServers(next)
        })
        .catch(() => {
          /* the chips simply stay as they were */
        })
    }
    load()
    const timer = setInterval(load, DEV_SERVER_POLL_MS)
    window.addEventListener("focus", load)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener("focus", load)
    }
  }, [sessionId])

  return servers
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
  const servers = useDevServers(sessionId)
  // A folder that is not a checkout still runs things: the git half stays
  // silent for it, and the dev servers are shown either way.
  const repo = status?.isGitRepo ? status : null
  const ahead = repo?.ahead ?? 0
  const behind = repo?.behind ?? 0
  const dirty = repo?.dirty ?? 0
  const pr = repo?.pr
  if (!ahead && !behind && !dirty && !pr && servers.length === 0) return null

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
      {servers.map((server) => (
        <button
          key={server.url}
          type="button"
          data-slot="folder-dev-server"
          title={[server.url, server.command, server.title]
            .filter(Boolean)
            .join(" · ")}
          onClick={(event) => {
            // Same as the pull request chip: the header is a disclosure, and
            // this click is not about opening it.
            event.stopPropagation()
            void openExternal(server.url)
          }}
          className={cn(
            chip,
            "text-sky-600 outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50 dark:text-sky-400"
          )}
        >
          <Globe className="size-2.5" />
          {server.port}
        </button>
      ))}
    </span>
  )
})
