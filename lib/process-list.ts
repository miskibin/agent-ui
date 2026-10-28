/**
 * The machine's process table, as plain data — and the questions the app asks
 * of it. Pure and free of `node:`, so every rule here is unit-tested;
 * `lib/process-scan.ts` is the half that actually runs `ps` or asks Windows.
 */

export type ProcInfo = {
  pid: number
  ppid: number
  /** POSIX process group. Absent on Windows, which has none to report. */
  pgid?: number
  /**
   * When the process started, in epoch ms. Exact on Windows; on POSIX it is
   * derived from the elapsed time `ps` reports, so it is good to a second —
   * which is why identity checks compare it with a tolerance.
   */
  startedAt: number
  /** The executable's base name, lowercased, without `.exe`. */
  name: string
  /** The full command line, when the platform would say. */
  command: string
}

/** `[[dd-]hh:]mm:ss` — `ps`'s `etime` — in seconds. */
export function parseEtime(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim())
  if (!match) return null
  const [, days, hours, minutes, seconds] = match
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds)
  )
}

/** `/usr/bin/node` or `C:\Program Files\nodejs\node.exe` → `node`. */
export function processName(executable: string): string {
  const base = executable.split(/[\\/]/).pop() ?? executable
  return base.replace(/\.exe$/i, "").toLowerCase()
}

/** The first word of a command line, honouring a quoted executable path. */
function firstWord(command: string): string {
  const text = command.trim()
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1)
    return end > 0 ? text.slice(1, end) : text.slice(1)
  }
  return text.split(/\s+/)[0] ?? ""
}

/**
 * `ps -A -ww -o pid=,ppid=,pgid=,etime=,args=` — one process per line, four
 * numbers-ish and then the command line, which may itself contain spaces.
 */
export function parsePsOutput(stdout: string, now = Date.now()): ProcInfo[] {
  const procs: ProcInfo[] = []
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    const elapsed = parseEtime(match[4])
    if (elapsed == null) continue
    const command = match[5].trim()
    procs.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: now - elapsed * 1000,
      name: processName(firstWord(command)),
      command,
    })
  }
  return procs
}

/**
 * The PowerShell scan's lines: `pid<TAB>ppid<TAB>ISO start<TAB>name<TAB>cmd`.
 * A process Windows will not describe (System, Idle) has no start time and is
 * skipped; nothing the app could have started looks like that.
 */
export function parseWindowsProcessLines(stdout: string): ProcInfo[] {
  const procs: ProcInfo[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, ppid, started, name, ...rest] = line.split("\t")
    const startedAt = Date.parse(started ?? "")
    if (!pid || !/^\d+$/.test(pid) || !Number.isFinite(startedAt)) continue
    const command = rest.join("\t").trim()
    procs.push({
      pid: Number(pid),
      ppid: Number(ppid) || 0,
      startedAt,
      name: processName(name || firstWord(command)),
      command: command || name || "",
    })
  }
  return procs
}

/**
 * Whether a process in a fresh scan is the one recorded earlier: same pid and
 * the same start, within what `ps`'s one-second resolution allows. A pid
 * alone is not an identity — it is recycled, and stopping a recycled pid
 * kills somebody else's program.
 */
export function sameProcess(
  recorded: { pid: number; startedAt: number },
  live: ProcInfo
): boolean {
  return recorded.pid === live.pid && Math.abs(recorded.startedAt - live.startedAt) <= 2_500
}

/** Every process below `rootPid`, by parent links, nearest first. */
export function descendantsOf(procs: ProcInfo[], rootPid: number): ProcInfo[] {
  const children = new Map<number, ProcInfo[]>()
  for (const proc of procs) {
    if (proc.pid === proc.ppid) continue
    const list = children.get(proc.ppid)
    if (list) list.push(proc)
    else children.set(proc.ppid, [proc])
  }
  const out: ProcInfo[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length) {
    const pid = queue.shift() as number
    for (const child of children.get(pid) ?? []) {
      // A child recorded as starting before its parent is a recycled pid
      // under a stale parent link, not a descendant.
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      out.push(child)
      queue.push(child.pid)
    }
  }
  return out
}

/** Shells a harness's command tool runs things through. */
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "fish",
  "nu",
  "cmd",
  "powershell",
  "pwsh",
  "wsl",
])

export function isShell(proc: Pick<ProcInfo, "name">): boolean {
  return SHELLS.has(proc.name)
}

/**
 * The processes a harness left running that are *work*, rather than the
 * harness's own plumbing.
 *
 * `snapshot` is the table taken just before the harness was let go; `root` is
 * the harness. Two ways in:
 *
 * - **Below a shell.** Everything an agent runs goes through its command
 *   tool, and every command tool is a shell — so a descendant with a shell
 *   at or above it (stopping at the harness) is something the agent ran. An
 *   MCP server or a language server the CLI started for itself has no shell
 *   above it and is left out; it dies with the CLI anyway.
 * - **The harness's process group** (POSIX, and only when the harness leads
 *   its own), for processes no longer attached below it. `nohup cmd &` from a
 *   tool's shell reparents `cmd` to init the moment that shell exits, which
 *   breaks every parent link back to the harness — but it keeps the group. Only a harness spawned as a group
 *   leader is eligible: one that shares the server's group would have the
 *   server itself, and everything else the server runs, "in" it.
 */
export function harnessWork(snapshot: ProcInfo[], root: number): ProcInfo[] {
  const byPid = new Map(snapshot.map((proc) => [proc.pid, proc]))
  const rootProc = byPid.get(root)
  const leadsGroup = rootProc?.pgid != null && rootProc.pgid === root

  const work = new Map<number, ProcInfo>()
  const attached = descendantsOf(snapshot, root)
  for (const proc of attached) {
    let cursor: ProcInfo | undefined = proc
    for (let depth = 0; cursor && cursor.pid !== root && depth < 64; depth++) {
      if (isShell(cursor)) {
        work.set(proc.pid, proc)
        break
      }
      cursor = byPid.get(cursor.ppid)
    }
  }
  if (leadsGroup) {
    // Only the ones cut loose: a descendant still attached was judged above,
    // and the CLI's own helpers share its group too.
    const below = new Set(attached.map((proc) => proc.pid))
    for (const proc of snapshot) {
      if (proc.pid !== root && proc.pgid === root && !below.has(proc.pid)) {
        work.set(proc.pid, proc)
      }
    }
  }
  return [...work.values()]
}

/**
 * Of a set of processes, only the outermost: a `bash watcher.sh` and the
 * `sleep 5` it is running right now are one row, not two, and stopping the
 * row stops its tree.
 */
export function outermost(procs: ProcInfo[]): ProcInfo[] {
  const pids = new Set(procs.map((proc) => proc.pid))
  return procs.filter((proc) => !pids.has(proc.ppid))
}

/**
 * Windows' way out of a process tree: `Start-Process`, `start`, `cmd /c start`
 * create a process whose parent exits a moment later. Windows keeps the dead
 * parent's pid on the child forever, so such a process is recognizable after
 * the fact — started inside the turn, parent nowhere to be found (or the pid
 * now belongs to something younger, i.e. it was recycled).
 *
 * Narrowed further, because a dead parent is not proof of anything: only
 * programs that do work in the background (shells, interpreters, runtimes,
 * build tools) qualify — never a GUI application the user opened meanwhile.
 */
const BACKGROUND_PROGRAMS = new Set([
  ...SHELLS,
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "pythonw",
  "py",
  "ruby",
  "perl",
  "php",
  "java",
  "dotnet",
  "go",
  "cargo",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "uv",
  "uvx",
  "conhost",
  "wscript",
  "cscript",
  "bash",
  "tail",
  "watchexec",
  "nodemon",
])

export function orphanedDuring(
  procs: ProcInfo[],
  window: { from: number; to: number },
  exclude: ReadonlySet<number>
): ProcInfo[] {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]))
  return procs.filter((proc) => {
    if (exclude.has(proc.pid)) return false
    if (proc.startedAt < window.from || proc.startedAt > window.to) return false
    if (!BACKGROUND_PROGRAMS.has(proc.name) || proc.name === "conhost") return false
    const parent = byPid.get(proc.ppid)
    return !parent || parent.startedAt > proc.startedAt
  })
}

/** `pid` and every process above it, by parent links, nearest first. */
export function ancestorsOf(procs: ProcInfo[], pid: number): ProcInfo[] {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]))
  const out: ProcInfo[] = []
  const seen = new Set<number>()
  for (let current = byPid.get(pid); current && !seen.has(current.pid); ) {
    seen.add(current.pid)
    out.push(current)
    const parent = byPid.get(current.ppid)
    // A parent that started after its child is a recycled pid, not a parent.
    if (!parent || parent.startedAt > current.startedAt + 2_500) break
    current = parent
  }
  return out
}

/**
 * Whether a command line names `folder` or something inside it — how a
 * listener is attributed to a folder where the platform publishes no working
 * directory (Windows). Separators are compared as `/`, a drive-letter path
 * case-insensitively, and the folder must end at a path boundary so `C:\app`
 * does not claim `C:\app-two`.
 */
export function mentionsFolder(command: string, folder: string): boolean {
  const windows = /^[a-z]:/i.test(folder)
  const norm = (value: string) => {
    const slashed = value.replace(/\\/g, "/")
    return windows ? slashed.toLowerCase() : slashed
  }
  const root = norm(folder).replace(/\/+$/, "")
  if (!root) return false
  const line = norm(command)
  for (let at = line.indexOf(root); at !== -1; at = line.indexOf(root, at + 1)) {
    const next = line[at + root.length]
    if (next === undefined || /[/\s"']/.test(next)) return true
  }
  return false
}
