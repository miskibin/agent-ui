import "server-only"

import { execFile, type ChildProcess } from "node:child_process"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { writeFileAtomic } from "@/lib/atomic-write"
import {
  descendantsOf,
  harnessWork,
  orphanedDuring,
  outermost,
  sameProcess,
  type ProcInfo,
} from "@/lib/process-list"
import { processCwd, scanProcesses } from "@/lib/process-scan"
import { killProcessTree } from "@/lib/process-tree"
import { dataDir } from "@/lib/settings/server"

/**
 * What an agent left running when its turn ended — a dev server, a watcher, a
 * `tail -f` — kept, attributed to the chat, and stoppable.
 *
 * Every harness used to take its whole process tree down at the end of every
 * turn, which made "start the dev server" a request no agent could fulfil:
 * the server died with the turn that started it. Agents learned to escape —
 * `nohup`, `setsid`, `Start-Process` — and then nothing in the app knew the
 * process existed at all. Both halves are fixed here:
 *
 * - A turn that *ends* lets its harness go (`TurnProcesses.release`) instead
 *   of killing the tree, after taking a snapshot of what is below it. A turn
 *   that is *stopped* still kills the tree: stop means stop.
 * - `settle` then looks at what survived — the shell-launched descendants and
 *   the harness's process group from that snapshot (`harnessWork`), plus, on
 *   Windows, programs started during the turn whose parent vanished
 *   (`orphanedDuring`), which is what `Start-Process` leaves behind — and
 *   records them under the chat in `$AGENT_UI_DIR/processes.json`.
 *
 * The record is a pid *and* its start time, so a recycled pid is never
 * mistaken for the process an agent started, and never killed in its place.
 * The file outlives the app: a dev server the user wanted is still listed —
 * and still stoppable — after a restart.
 *
 * This is deliberately harness-agnostic. T3 Code tracks the same thing from
 * each CLI's own protocol events (Claude's `task_started`, Codex's background
 * terminals), which sees only what the harness itself chose to track; an
 * agent that ran `nohup` is invisible to it. The process table sees all of
 * them.
 */

export type BackgroundProcess = {
  pid: number
  startedAt: number
  sessionId: string
  providerId: string
  /** The executable's name, for the row's headline. */
  name: string
  command: string
  cwd?: string
  /** When this app first saw it outlive a turn. */
  detectedAt: number
}

type ProcessFile = { version: 1; processes: BackgroundProcess[] }

const FILE_VERSION = 1
/** Survivors are counted this long after the harness is let go. */
const SETTLE_GRACE_MS = 1_500
/** A GET waits at most this long for a turn's survivors to be counted. */
const SETTLE_WAIT_MS = 8_000
/** Past this the list is a leak report, not a list. */
const MAX_PER_SESSION = 50
const FORCE_KILL_MS = 1_500

const filePath = () => join(dataDir(), "processes.json")

type Store = {
  /** Writes are serialized: two turns settling at once share one file. */
  chain: Promise<unknown>
  /** Turns whose survivors are still being counted, by chat. */
  settling: Map<string, Set<Promise<void>>>
  /** Turns running right now — `orphanedDuring` attributes only when one is. */
  active: Set<TurnProcesses>
}

const store: Store = ((globalThis as { __agentUiBackground?: Store }).__agentUiBackground ??= {
  chain: Promise.resolve(),
  settling: new Map(),
  active: new Set(),
})

async function readAll(): Promise<BackgroundProcess[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath(), "utf8")) as Partial<ProcessFile>
    return Array.isArray(parsed.processes) ? parsed.processes.filter(isEntry) : []
  } catch {
    return []
  }
}

function isEntry(value: unknown): value is BackgroundProcess {
  const entry = value as BackgroundProcess
  return (
    !!entry &&
    Number.isInteger(entry.pid) &&
    typeof entry.startedAt === "number" &&
    typeof entry.sessionId === "string" &&
    typeof entry.command === "string"
  )
}

async function writeAll(processes: BackgroundProcess[]) {
  await mkdir(dataDir(), { recursive: true })
  const body: ProcessFile = { version: FILE_VERSION, processes }
  await writeFileAtomic(filePath(), `${JSON.stringify(body, null, 2)}\n`)
}

/** Read-modify-write, one at a time. */
function update(
  change: (processes: BackgroundProcess[]) => BackgroundProcess[]
): Promise<BackgroundProcess[]> {
  const next = store.chain.then(async () => {
    const before = await readAll()
    const after = change(before)
    if (JSON.stringify(after) !== JSON.stringify(before)) await writeAll(after)
    return after
  })
  store.chain = next.catch(() => undefined)
  return next
}

/** Entries whose process is still the one that was recorded. */
function alive(entries: BackgroundProcess[], procs: ProcInfo[]) {
  if (procs.length === 0) return entries // a failed scan proves nothing
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]))
  return entries.filter((entry) => {
    const live = byPid.get(entry.pid)
    return !!live && sameProcess(entry, live)
  })
}

/**
 * The chat's background processes that are still running — or every chat's,
 * without a `sessionId`. Waits for a turn that just ended to finish counting
 * its survivors, so the request the page makes on a turn's end sees them.
 */
export async function listBackground(sessionId?: string): Promise<BackgroundProcess[]> {
  const pending = sessionId
    ? [...(store.settling.get(sessionId) ?? [])]
    : [...store.settling.values()].flatMap((set) => [...set])
  if (pending.length) {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS)),
    ])
  }
  const procs = await scanProcesses()
  const live = await update((all) => alive(all, procs))
  return sessionId ? live.filter((entry) => entry.sessionId === sessionId) : live
}

/**
 * Stops one of the chat's processes (`pid`), or all of them, tree and all.
 * Only a pid this file recorded for this chat — and still the same process —
 * can be named: the route is not a way to kill arbitrary pids.
 */
export async function stopBackground(sessionId: string, pid?: number): Promise<number> {
  const procs = await scanProcesses({ fresh: true })
  const entries = alive(await readAll(), procs).filter(
    (entry) => entry.sessionId === sessionId && (pid === undefined || entry.pid === pid)
  )
  await Promise.all(entries.map((entry) => killTree(entry.pid, procs)))
  const stopped = new Set(entries.map((entry) => `${entry.pid}:${entry.startedAt}`))
  await update((all) => all.filter((entry) => !stopped.has(`${entry.pid}:${entry.startedAt}`)))
  return entries.length
}

/** Forget a deleted chat's entries — its processes are the user's to stop. */
export async function forgetBackground(sessionId: string): Promise<void> {
  await update((all) => all.filter((entry) => entry.sessionId !== sessionId))
}

function killTree(pid: number, procs: ProcInfo[]): Promise<void> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () =>
        resolve()
      )
    })
  }
  const root = procs.find((proc) => proc.pid === pid)
  const targets = [pid, ...descendantsOf(procs, pid).map((proc) => proc.pid)]
  const signal = (sig: NodeJS.Signals) => {
    // A group of its own is reached in one call, grandchildren included.
    if (root?.pgid === pid) {
      try {
        process.kill(-pid, sig)
      } catch {
        /* gone */
      }
    }
    for (const target of targets) {
      try {
        process.kill(target, sig)
      } catch {
        /* gone */
      }
    }
  }
  signal("SIGTERM")
  return new Promise((resolve) => {
    setTimeout(() => {
      signal("SIGKILL")
      resolve()
    }, FORCE_KILL_MS).unref?.()
  })
}

/**
 * One turn's view of the processes it is responsible for. The chat route
 * makes one per turn and hands it to the provider (`AgentRunOptions.processes`);
 * the provider calls `release` where it used to kill its harness at a normal
 * end, or `observe` when the harness is long-lived and stays (ACP); the route
 * calls `settle` once the turn is over.
 */
export class TurnProcesses {
  private readonly releases: Promise<ProcInfo[]>[] = []
  private readonly observed = new Set<number>()
  /** Every harness this turn let go, alive or not when it did. */
  private readonly roots = new Set<number>()
  private endedAt: number | null = null

  constructor(
    private readonly turn: {
      sessionId: string
      providerId: string
      cwd?: string
      startedAt: number
    }
  ) {
    store.active.add(this)
  }

  /**
   * A normal end: snapshot what is below the harness, then stop the harness
   * alone. Never awaited by the provider — the snapshot costs a process scan,
   * and the turn's answer is not going to wait for one.
   */
  release(child: ChildProcess): void {
    const pid = child.pid
    if (pid === undefined) return
    this.roots.add(pid)
    // A CLI that already exited on its own leaves no tree to snapshot; what it
    // left behind is found by its process group in `count`.
    if (child.exitCode != null || child.signalCode != null) return
    this.releases.push(
      scanProcesses({ fresh: true })
        .then((procs) => {
          if (procs.length === 0) {
            // No table, no way to tell work from plumbing: the old behaviour.
            killProcessTree(child)
            return []
          }
          const work = harnessWork(procs, pid)
          letGo(child, leftovers(procs, pid, work))
          return work
        })
        .catch(() => {
          // No table, no way to tell work from plumbing: the old behaviour.
          killProcessTree(child)
          return []
        })
    )
  }

  /** A harness that outlives the turn: what it started *during* it counts. */
  observe(pid: number | undefined): void {
    if (pid !== undefined) this.observed.add(pid)
  }

  /**
   * Counts the survivors and records them. Safe to call without awaiting; a
   * GET for this chat waits on it.
   */
  settle(): Promise<void> {
    this.endedAt = Date.now()
    const work = this.count().finally(() => {
      store.active.delete(this)
      const set = store.settling.get(this.turn.sessionId)
      set?.delete(work)
      if (set?.size === 0) store.settling.delete(this.turn.sessionId)
    })
    const set = store.settling.get(this.turn.sessionId) ?? new Set()
    set.add(work)
    store.settling.set(this.turn.sessionId, set)
    return work.catch(() => undefined)
  }

  private async count(): Promise<void> {
    // A turn that never ran a harness (Ollama, a hosted chat model) has
    // nothing below it to look for, and is not worth a process scan.
    if (this.roots.size === 0 && this.observed.size === 0) return
    const released = (await Promise.all(this.releases)).flat()
    await new Promise((resolve) => setTimeout(resolve, SETTLE_GRACE_MS))
    const procs = await scanProcesses({ fresh: true })
    const window = { from: this.turn.startedAt - 1_000, to: this.endedAt ?? Date.now() }

    const candidates = new Map<number, ProcInfo>()
    for (const proc of released) candidates.set(proc.pid, proc)
    // A process group outlives its leader, and a leader's pid cannot be
    // reused while the group exists — so a group named after a harness this
    // turn let go is still that harness's, even after it exited.
    if (process.platform !== "win32") {
      for (const proc of procs) {
        if (
          proc.pgid !== undefined &&
          this.roots.has(proc.pgid) &&
          !this.roots.has(proc.pid) &&
          proc.startedAt >= window.from
        ) {
          candidates.set(proc.pid, proc)
        }
      }
    }
    for (const pid of this.observed) {
      for (const proc of harnessWork(procs, pid)) {
        if (proc.startedAt >= window.from) candidates.set(proc.pid, proc)
      }
    }
    // Only when this is the one turn running: an orphan cannot say which of
    // two concurrent turns started it, and a wrong chat is worse than none.
    if (process.platform === "win32" && store.active.size <= 1) {
      const exclude = new Set([process.pid, ...this.observed, ...this.roots])
      for (const proc of orphanedDuring(procs, window, exclude)) candidates.set(proc.pid, proc)
    }

    const survivors = outermost(
      [...candidates.values()].filter((candidate) =>
        procs.some((live) => sameProcess(candidate, live))
      )
    )
    if (survivors.length === 0) return

    const now = Date.now()
    const entries: BackgroundProcess[] = await Promise.all(
      survivors.map(async (proc) => {
        const cwd = (await processCwd(proc.pid)) ?? this.turn.cwd
        return {
          pid: proc.pid,
          startedAt: proc.startedAt,
          sessionId: this.turn.sessionId,
          providerId: this.turn.providerId,
          name: proc.name,
          command: proc.command,
          ...(cwd ? { cwd } : null),
          detectedAt: now,
        }
      })
    )
    await update((all) => {
      const known = alive(all, procs)
      const fresh = entries.filter(
        (entry) => !known.some((item) => item.pid === entry.pid)
      )
      const merged = [...known, ...fresh]
      const mine = merged.filter((entry) => entry.sessionId === this.turn.sessionId)
      if (mine.length <= MAX_PER_SESSION) return merged
      const drop = new Set(mine.slice(0, mine.length - MAX_PER_SESSION))
      return merged.filter((entry) => !drop.has(entry))
    })
  }
}

/**
 * What is below the harness and is *not* the agent's work — the CLI's MCP
 * servers, a language server, a tool call still winding down. These go with
 * the harness, exactly as the old tree kill took them, so keeping the work is
 * the only thing that changed.
 */
function leftovers(procs: ProcInfo[], root: number, work: ProcInfo[]): number[] {
  const kept = new Set<number>()
  for (const proc of work) {
    kept.add(proc.pid)
    for (const below of descendantsOf(procs, proc.pid)) kept.add(below.pid)
  }
  return descendantsOf(procs, root)
    .map((proc) => proc.pid)
    .filter((pid) => !kept.has(pid))
}

/**
 * The harness and its leftovers, but not the work: one pid at a time, never
 * the group (which the work may share) and never `taskkill /T`.
 */
function letGo(child: ChildProcess, others: number[] = []) {
  if (child.exitCode == null && child.signalCode == null) {
    try {
      child.kill("SIGTERM")
    } catch {
      killProcessTree(child)
    }
  }
  for (const pid of others) {
    if (process.platform === "win32") {
      execFile("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true }, () => {})
      continue
    }
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* gone */
    }
  }
}
