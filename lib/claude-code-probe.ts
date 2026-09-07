import "server-only"

import { spawn } from "node:child_process"

import { parseCliLine, usageResponseToLimits } from "@/lib/claude-code-protocol"
import {
  resolveClaudeCodeCommand,
  type ClaudeCodeCommand,
} from "@/lib/claude-code-runtime"
import { LineBuffer } from "@/lib/stream-framing"
import type { ProviderUsageLimits } from "@/lib/usage-limits"

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
/**
 * The init handshake, on its own.
 *
 * `claude -p` answers a great deal about itself before it has been asked
 * anything: the model it resolved, the CLI's version, where its credentials
 * came from, the tools, MCP servers and slash commands this folder actually
 * gives it. All of that rides on the `system:init` line, which the CLI emits
 * once startup finishes and *before* it reads a prompt.
 *
 * So the probe spawns the same argv a turn uses, holds stdin open, never
 * writes a byte to it, reads the one line it wants and kills the process. No
 * prompt is ever sent, which means no request reaches Anthropic and the probe
 * costs nothing — but it does prove the binary runs, the folder is readable
 * and the credentials are there, which is more than `existsSync` can say.
 *
 * It is never on the path of a turn: `run()` does not call it, and `info()`
 * waits for it only briefly and then answers from what it already knew.
 */

/** Bedrock and a cold first launch are slow; anything past this is stuck. */
const PROBE_BUDGET_MS = 25_000
/** How long a good answer stands before the next caller pays for a new one. */
const FRESH_MS = 5 * 60_000
/** And how long a failure does, so a broken install is not re-spawned per row. */
const FAILED_FRESH_MS = 30_000

export type ClaudeCodeMcpServer = { name: string; status?: string }

export type ClaudeCodeProbe = {
  ok: boolean
  /** When this answer was taken. */
  at: number
  /** Why it failed — the CLI's own words where it had any. */
  error?: string
  /** True when the failure is the account, not the machine. See `isAuthFailure`. */
  signedOut?: boolean
  model?: string
  version?: string
  /** `none`, `ANTHROPIC_API_KEY`, … — how the CLI is authenticating. */
  apiKeySource?: string
  /** Whatever the init line carried about the logged-in account. */
  account?: Record<string, unknown>
  cwd?: string
  permissionMode?: string
  tools: string[]
  mcpServers: ClaudeCodeMcpServer[]
  slashCommands: string[]
  /** Subscription windows, on a CLI new enough to put them on the init line. */
  usageLimits?: ProviderUsageLimits
}

/** Only the init fields worth reading; the line carries a good deal more. */
type ClaudeInitLine = {
  model?: unknown
  claude_code_version?: unknown
  apiKeySource?: unknown
  account?: unknown
  cwd?: unknown
  permissionMode?: unknown
  tools?: unknown
  mcp_servers?: unknown
  slash_commands?: unknown
}

const cache = new Map<string, ClaudeCodeProbe>()
const inFlight = new Map<string, Promise<ClaudeCodeProbe>>()

function keyFor(command: ClaudeCodeCommand, cwd: string) {
  return `${command.cmd} ${command.args.join(" ")} ${cwd}`
}

function isFresh(probe: ClaudeCodeProbe, now: number) {
  return now - probe.at < (probe.ok ? FRESH_MS : FAILED_FRESH_MS)
}

/**
 * The probe's answer, or `undefined` when none is known yet.
 *
 * `waitMs` is what keeps this off the hot path: a caller that cannot afford
 * to block (the provider list is rendered from `info()`) waits a moment for a
 * cold probe and then answers without it, while the spawn finishes in the
 * background and fills the cache for the next call. A cached answer costs
 * nothing at all.
 */
export async function probeClaudeCode(options: {
  binPath?: string
  cwd?: string
  waitMs?: number
}): Promise<ClaudeCodeProbe | undefined> {
  const command = resolveClaudeCodeCommand(options.binPath)
  const cwd = options.cwd?.trim() || process.cwd()
  const key = keyFor(command, cwd)

  const cached = cache.get(key)
  if (cached && isFresh(cached, Date.now())) return cached

  let pending = inFlight.get(key)
  if (!pending) {
    pending = runProbe(command, cwd)
      .then((probe) => {
        cache.set(key, probe)
        return probe
      })
      .finally(() => {
        inFlight.delete(key)
      })
    inFlight.set(key, pending)
  }

  const waitMs = options.waitMs ?? PROBE_BUDGET_MS
  const raced = await Promise.race([
    pending,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), waitMs)
      timer.unref?.()
    }),
  ])
  // A stale answer beats none while the fresh one is still being taken.
  return raced ?? cached
}

/** Whatever the last completed probe said, without ever starting one. */
export function lastClaudeCodeProbe(
  binPath?: string,
  cwd?: string
): ClaudeCodeProbe | undefined {
  const command = resolveClaudeCodeCommand(binPath)
  return cache.get(keyFor(command, cwd?.trim() || process.cwd()))
}

/** For a settings change that invalidates what we knew. */
export function forgetClaudeCodeProbe() {
  cache.clear()
}

function runProbe(
  command: ClaudeCodeCommand,
  cwd: string
): Promise<ClaudeCodeProbe> {
  return new Promise((resolve) => {
    const args = [
      ...command.args,
      "-p",
      "--output-format",
      "stream-json",
      // stream-json refuses to run without it, exactly as a turn does.
      "--verbose",
      // Without this the CLI waits for stdin to *close* before it starts, and
      // the probe's whole trick is that stdin never closes.
      "--input-format",
      "stream-json",
      // Nothing may be approved: the probe must not be able to run a tool
      // even if some line it never sends were to ask for one.
      "--permission-mode",
      "dontAsk",
    ]

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(/*turbopackIgnore: true*/ command.cmd, args, {
        cwd,
        env: probeEnv(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (err) {
      resolve(failed(err instanceof Error ? err.message : "spawn failed"))
      return
    }

    let settled = false
    const stderrChunks: string[] = []
    const lines = new LineBuffer()

    const done = (probe: ClaudeCodeProbe) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill("SIGTERM")
      } catch {
        /* already gone */
      }
      resolve(probe)
    }

    const timer = setTimeout(() => {
      done(failed("Claude Code did not finish starting up in 25s"))
    }, PROBE_BUDGET_MS)
    timer.unref?.()

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdin?.on("error", () => {
      /* nothing is ever written to it; it exists only to stay open */
    })
    child.stderr?.on("data", (chunk: string) => {
      stderrChunks.push(chunk)
    })
    child.stdout?.on("data", (chunk: string) => {
      for (const line of lines.push(chunk)) {
        const event = parseCliLine(line)
        if (!event || event.type !== "system" || event.subtype !== "init") {
          continue
        }
        done(readInit(event as ClaudeInitLine, event))
        return
      }
    })
    child.once("error", (err: NodeJS.ErrnoException) => {
      done(failed(err.message))
    })
    child.once("close", (code) => {
      // Exited before the init line: the CLI refused to start, and its stderr
      // is the only account of why.
      const text = stderrChunks.join("").trim()
      done(failed(text || `claude exited with code ${code ?? 1}`))
    })
  })
}

/**
 * The probe is a health check, not a session: it must not connect to an IDE,
 * install anything, or pull in the MCP servers a claude.ai account carries —
 * all of which cost seconds and, on Windows, spawn a process tree per call.
 * The user's own settings and hooks are left alone deliberately: they are
 * what make this folder's slash commands and tools what they are, which is
 * half of what the probe is asking about.
 */
function probeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  env.CLAUDE_CODE_AUTO_CONNECT_IDE = "0"
  env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = "1"
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false"
  delete env.FORCE_CODE_TERMINAL
  return env
}

function readInit(
  init: ClaudeInitLine,
  raw: Parameters<typeof usageResponseToLimits>[0]
): ClaudeCodeProbe {
  const at = Date.now()
  const limits = usageResponseToLimits(raw, new Date(at).toISOString())
  return {
    ok: true,
    at,
    ...(str(init.model) ? { model: str(init.model) } : null),
    ...(str(init.claude_code_version)
      ? { version: str(init.claude_code_version) }
      : null),
    ...(str(init.apiKeySource) ? { apiKeySource: str(init.apiKeySource) } : null),
    ...(init.account && typeof init.account === "object"
      ? { account: init.account as Record<string, unknown> }
      : null),
    ...(str(init.cwd) ? { cwd: str(init.cwd) } : null),
    ...(str(init.permissionMode)
      ? { permissionMode: str(init.permissionMode) }
      : null),
    tools: strings(init.tools),
    mcpServers: mcpServers(init.mcp_servers),
    slashCommands: strings(init.slash_commands),
    ...(limits ? { usageLimits: limits } : null),
  }
}

function failed(message: string): ClaudeCodeProbe {
  return {
    ok: false,
    at: Date.now(),
    error: message,
    ...(isAuthFailure(message) ? { signedOut: true } : null),
    tools: [],
    mcpServers: [],
    slashCommands: [],
  }
}

/**
 * A failure that is about the account rather than the machine. It is the only
 * kind the provider turns into "unavailable": a probe that timed out, hit an
 * unknown flag or crashed says nothing certain about whether a turn would
 * work, and hiding a working harness on that evidence is worse than showing
 * one that fails loudly on its first run.
 */
function isAuthFailure(message: string): boolean {
  return /not (logged in|authenticated)|auth(entication)? (failed|required|error)|run .?claude (auth )?login|invalid api key|unauthorized|credit balance/i.test(
    message
  )
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}

function mcpServers(value: unknown): ClaudeCodeMcpServer[] {
  if (!Array.isArray(value)) return []
  const servers: ClaudeCodeMcpServer[] = []
  for (const entry of value) {
    if (typeof entry === "string") {
      servers.push({ name: entry })
      continue
    }
    if (!entry || typeof entry !== "object") continue
    const record = entry as { name?: unknown; status?: unknown }
    const name = str(record.name)
    if (!name) continue
    servers.push({
      name,
      ...(str(record.status) ? { status: str(record.status) } : null),
    })
  }
  return servers
}
