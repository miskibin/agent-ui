import "server-only"

import { execFile } from "node:child_process"
import { readlink } from "node:fs/promises"

import {
  descendantsOf,
  parsePsOutput,
  parseWindowsProcessLines,
  type ProcInfo,
} from "@/lib/process-list"

/**
 * The process table, read the cheapest way each platform allows.
 *
 * POSIX asks `ps` once for every process (`-ww`, or long command lines come
 * back cut at the terminal width nobody has). Windows asks CIM through one
 * PowerShell, which is the only built-in that reports a process's *parent*
 * and its exact start — `tasklist` knows neither, and `wmic` is gone from
 * current builds. That call costs most of a second, so a scan is shared:
 * callers within `CACHE_MS` get the same table, and concurrent ones the same
 * promise.
 */

const SCAN_TIMEOUT_MS = 8_000
const CACHE_MS = 1_500
const MAX_BUFFER = 16 * 1024 * 1024

const WINDOWS_SCAN = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Get-CimInstance Win32_Process | ForEach-Object {",
  "  if ($_.CreationDate) {",
  "    $cmd = if ($_.CommandLine) { $_.CommandLine -replace '[\\t\\r\\n]', ' ' } else { '' }",
  "    \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CreationDate.ToUniversalTime().ToString('o'))`t$($_.Name)`t$cmd\"",
  "  }",
  "}",
].join("\n")

let cached: { at: number; procs: ProcInfo[] } | null = null
let inFlight: Promise<ProcInfo[]> | null = null

/**
 * Windows: started with no console at all (`detached` is `DETACHED_PROCESS`).
 * `windowsHide` alone still gives a console program a hidden console host,
 * and one started on a timer while another app has focus can take the
 * keyboard from it. Safe here because this program starts no console
 * children of its own, which would otherwise open a visible window.
 */
const NO_CONSOLE = process.platform === "win32" ? { detached: true } : {}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: SCAN_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, ...NO_CONSOLE },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}

async function readTable(): Promise<ProcInfo[]> {
  if (process.platform === "win32") {
    const stdout = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_SCAN,
    ])
    return parseWindowsProcessLines(stdout)
  }
  const stdout = await run("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,etime=,args="])
  return parsePsOutput(stdout)
}

/**
 * Every process on the machine. `fresh` skips the cache — for the reads that
 * decide what a turn left behind, where a table from before the turn ended
 * would answer the wrong question. A failed scan is an empty table: the
 * feature it serves is an aid, and never worth an error.
 */
export async function scanProcesses(options: { fresh?: boolean } = {}): Promise<ProcInfo[]> {
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.procs
  if (inFlight) return inFlight
  inFlight = readTable()
    .then((procs) => {
      // This server's own scan is in the table it produced; leave it out.
      const self = new Set(descendantsOf(procs, process.pid).map((proc) => proc.pid))
      const table = procs.filter(
        (proc) => !(self.has(proc.pid) && /^(ps|powershell)$/.test(proc.name))
      )
      cached = { at: Date.now(), procs: table }
      return table
    })
    .catch(() => [] as ProcInfo[])
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/**
 * Where a process is running, where the platform says so cheaply: Linux
 * exposes it as a symlink. Elsewhere it would cost an lsof per process, and
 * the chat's own folder is what the row shows instead.
 */
export async function processCwd(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined
  return readlink(`/proc/${pid}/cwd`).catch(() => undefined)
}
