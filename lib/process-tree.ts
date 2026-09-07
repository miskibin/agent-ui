import "server-only"

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

import { execFile, type ChildProcess } from "node:child_process"

/**
 * Killing a harness means killing everything it started.
 *
 * `child.kill()` reaches the CLI in front of the agent and nothing else, so a
 * `npm run dev`, a `pytest`, a `tail -f` its shell tool spawned keeps running —
 * and keeps holding the port, the lock, the CPU — long after the user stopped
 * the turn. The fix is two halves that have to agree: spawn with
 * `detached: DETACH_CHILDREN`, which puts the child at the head of its own
 * process group, and terminate with `killProcessTree`, which signals the
 * *negative* pid and so reaches every process in that group.
 *
 * Spawning without `detached` and then signalling `-pid` would be worse than
 * doing nothing: the child would share this server's own group, and a `-pid`
 * that happened to name a real group id would signal somebody else's
 * processes. The two are therefore exported together and must be used
 * together.
 *
 * Windows has no process groups to signal; `taskkill /T /F` walks the tree
 * instead. `lib/cursor-agent.ts` carries its own copy of all of this, because
 * it is vendored from chat-components and may not import out of this app.
 */

/** Whether a spawn on this platform can lead a process group. */
export const DETACH_CHILDREN = process.platform !== "win32"

/** Spread into a `spawn` options object to put the child in its own group. */
export const detachedSpawnOptions = { detached: DETACH_CHILDREN } as const

/** How long the group gets to unwind on SIGTERM before SIGKILL follows. */
const FORCE_KILL_MS = 1000

/** One escalation per child: a second call must not restart the clock. */
const killing = new WeakSet<ChildProcess>()

/**
 * SIGTERM to the whole group, then SIGKILL to whatever is still there a second
 * later. Every step is guarded: by the time this runs the group is usually
 * already gone, and that is the normal case rather than an error.
 */
export function killProcessTree(
  child: ChildProcess,
  forceAfterMs = FORCE_KILL_MS
): void {
  if (child.exitCode != null || child.signalCode != null) return
  if (killing.has(child)) return
  killing.add(child)

  if (!DETACH_CHILDREN) {
    try {
      execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], () => {
        // Best effort: the tree may already be gone, and there is nothing left
        // to report it to.
      })
    } catch {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    return
  }

  signalGroup(child, "SIGTERM")
  const timer = setTimeout(() => signalGroup(child, "SIGKILL"), forceAfterMs)
  timer.unref?.()
  child.once("close", () => clearTimeout(timer))
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  const pid = child.pid
  if (pid === undefined) return
  if (child.exitCode != null || child.signalCode != null) return
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already gone, or this child never led one (a spawn that
    // failed has no group at all). Fall back to the direct child.
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

/* -------------------------------------------------------------------------- */

/**
 * A detached child is in its own process group, which is exactly why the
 * Ctrl-C that reaches this server does not reach it. Nothing else would ever
 * kill it, so the server's own exit sweeps whatever it still has running.
 */
const live = new Set<ChildProcess>()
let exitHookInstalled = false

export function trackChildProcess(child: ChildProcess): void {
  live.add(child)
  child.once("close", () => live.delete(child))
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", () => {
    // An `exit` handler may only do synchronous work; `process.kill` is.
    for (const running of live) {
      if (running.pid === undefined) continue
      try {
        process.kill(DETACH_CHILDREN ? -running.pid : running.pid, "SIGKILL")
      } catch {
        /* already gone */
      }
    }
    live.clear()
  })
}
