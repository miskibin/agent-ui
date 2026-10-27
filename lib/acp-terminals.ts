import "server-only"

import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"

import { ACP_ERROR, AcpRpcError, type AcpCreateTerminalParams } from "@/lib/acp-types"
import {
  detachedSpawnOptions,
  killProcessTree,
  trackChildProcess,
} from "@/lib/process-tree"

/**
 * The client half of ACP's `terminal/*` methods: the agent asks *us* to run a
 * command, then polls its output, waits for it, kills it and releases it.
 *
 * It exists because agents built for editors (Claude Code's and Gemini's ACP
 * adapters among them) run their shell tool through the client when the
 * client offers `terminal: true`, and fall back to something poorer — or to
 * nothing — when it does not.
 *
 * Every terminal belongs to the agent process that created it and dies with
 * it: `disposeAll` runs when that process is evicted, so nothing started on
 * an agent's behalf outlives the agent.
 */

/** What one terminal keeps by default, when the agent names no limit. */
const DEFAULT_OUTPUT_LIMIT = 1_000_000
/** And at most, whatever it names. */
const MAX_OUTPUT_LIMIT = 4_000_000

type ExitStatus = { exitCode: number | null; signal: string | null }

type Terminal = {
  child: ChildProcess
  output: string
  truncated: boolean
  limit: number
  exit: ExitStatus | null
  exited: Promise<ExitStatus>
}

export class AcpTerminals {
  private terminals = new Map<string, Terminal>()
  private nextId = 0

  /**
   * `root` confines the working directory: a `cwd` outside it, or none, runs
   * in the root itself.
   */
  create(params: AcpCreateTerminalParams, root: string): { terminalId: string } {
    const command = params.command?.trim()
    if (!command) throw new AcpRpcError(ACP_ERROR.invalidParams, "command is required")
    const cwd = confined(root, params.cwd ?? undefined)
    const env: Record<string, string> = {}
    for (const entry of params.env ?? []) {
      if (entry?.name) env[entry.name] = entry.value ?? ""
    }
    const args = Array.isArray(params.args) ? params.args.filter((a) => typeof a === "string") : []
    // A bare command line with no argv is what a shell would have been handed.
    const [file, argv] =
      args.length > 0
        ? [command, args]
        : process.platform === "win32"
          ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command]]
          : ["/bin/sh", ["-c", command]]

    const child = spawn(/*turbopackIgnore: true*/ file, argv, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...detachedSpawnOptions,
    })
    trackChildProcess(child)

    const limit = Math.min(
      Math.max(1, Math.floor(params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT)),
      MAX_OUTPUT_LIMIT
    )
    const terminal: Terminal = {
      child,
      output: "",
      truncated: false,
      limit,
      exit: null,
      exited: new Promise<ExitStatus>((resolve) => {
        child.once("error", (err) => {
          terminal.output += `${err.message}\n`
          const status = { exitCode: 127, signal: null }
          terminal.exit ??= status
          resolve(terminal.exit)
        })
        child.once("close", (code, signal) => {
          terminal.exit ??= { exitCode: code, signal: signal ?? null }
          resolve(terminal.exit)
        })
      }),
    }
    const append = (chunk: string) => {
      terminal.output += chunk
      if (Buffer.byteLength(terminal.output, "utf8") > terminal.limit) {
        terminal.output = tailWithinBytes(terminal.output, terminal.limit)
        terminal.truncated = true
      }
    }
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)

    const terminalId = `term-${++this.nextId}`
    this.terminals.set(terminalId, terminal)
    return { terminalId }
  }

  output(terminalId: string | undefined) {
    const terminal = this.get(terminalId)
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exit ? { exitStatus: terminal.exit } : null),
    }
  }

  async waitForExit(terminalId: string | undefined): Promise<ExitStatus> {
    return this.get(terminalId).exited
  }

  kill(terminalId: string | undefined) {
    const terminal = this.get(terminalId)
    if (!terminal.exit) killProcessTree(terminal.child)
    return {}
  }

  release(terminalId: string | undefined) {
    const terminal = this.get(terminalId)
    if (!terminal.exit) killProcessTree(terminal.child)
    this.terminals.delete(terminalId!)
    return {}
  }

  /** The current output of a terminal, for a tool row that embeds one. */
  peek(terminalId: string): string | undefined {
    return this.terminals.get(terminalId)?.output
  }

  disposeAll() {
    for (const terminal of this.terminals.values()) {
      if (!terminal.exit) killProcessTree(terminal.child)
    }
    this.terminals.clear()
  }

  private get(terminalId: string | undefined): Terminal {
    const terminal = terminalId ? this.terminals.get(terminalId) : undefined
    if (!terminal) {
      throw new AcpRpcError(ACP_ERROR.resourceNotFound, `Unknown terminal ${terminalId ?? ""}`)
    }
    return terminal
  }
}

function confined(root: string, requested: string | undefined): string {
  const base = path.resolve(/*turbopackIgnore: true*/ root)
  if (!requested) return base
  const resolved = path.resolve(/*turbopackIgnore: true*/ base, requested)
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : base
}

/** The longest tail of `text` within `limit` UTF-8 bytes, cut on a character. */
export function tailWithinBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= limit) return text
  let start = bytes.length - limit
  // Step past continuation bytes so the cut lands on a character boundary.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString("utf8")
}
