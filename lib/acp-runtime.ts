import "server-only"

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Locates a configured ACP agent's command without loading `child_process`,
 * for the same reason `lib/pi-runtime.ts` does: a provider listing — which
 * happens on every page load, once per configured agent — must not pull the
 * spawn path in. `lib/acp-agent.ts` owns the process itself.
 *
 * Unlike the pi/cursor runtimes this is generalized over a *configurable*
 * command, so the built-in `dsh` entry and any user-added ACP agent are served
 * by the same two functions.
 */

export type AcpCommand = { cmd: string; args: string[] }

/**
 * A JS entry point needs a Node to run it; anything else is executable —
 * except on Windows, where `npm i -g` installs an agent as a `.cmd` shim and
 * Node refuses to spawn `.cmd`/`.bat` without a shell (EINVAL, ever since the
 * fix for CVE-2024-27980) while a bare `dsh` is not found at all (ENOENT,
 * because the extensionless sibling is a shell script). Running the shim
 * through `cmd.exe` would mean passing the prompt through its quoting, so we
 * look past it for the JS entry point it wraps — the same trade
 * `lib/pi-runtime.ts` makes, generalized here over a configurable command.
 */
export function resolveAcpCommand(command: string, args: string[]): AcpCommand {
  const target = command.trim()
  if (/\.[cm]?js$/.test(target)) {
    return { cmd: process.execPath, args: [target, ...args] }
  }
  if (process.platform === "win32") {
    const resolved = resolveWindowsTarget(target)
    if (resolved) {
      return resolved.entry
        ? { cmd: process.execPath, args: [resolved.entry, ...args] }
        : { cmd: resolved.exe!, args: [...args] }
    }
  }
  return { cmd: target, args: [...args] }
}

type WindowsTarget = { exe?: string; entry?: string }

/**
 * An explicit path is taken as given (looking through it only when it is a
 * shim); a bare name is searched on PATH, preferring a real `.exe` over a shim.
 */
function resolveWindowsTarget(target: string): WindowsTarget | null {
  if (!target) return null
  if (target.includes("/") || target.includes("\\") || path.isAbsolute(target)) {
    if (!SHIM_EXT.test(target)) return null
    const entry = shimEntry(target)
    return entry ? { entry } : null
  }
  for (const dir of pathDirs()) {
    const exe = path.join(/*turbopackIgnore: true*/ dir, `${target}.exe`)
    if (existsSync(/*turbopackIgnore: true*/ exe)) return { exe }
    for (const ext of [".cmd", ".bat"]) {
      const shim = path.join(/*turbopackIgnore: true*/ dir, `${target}${ext}`)
      if (!existsSync(/*turbopackIgnore: true*/ shim)) continue
      const entry = shimEntry(shim)
      if (entry) return { entry }
    }
  }
  return null
}

const SHIM_EXT = /\.(cmd|bat)$/i

/**
 * npm's Windows shim ends in a line naming the package entry relative to the
 * shim's own directory (`"%dp0%\node_modules\<pkg>\bin.js"`), which is the
 * only thing here worth reading out of it.
 */
function shimEntry(shim: string): string | null {
  try {
    const match = /%dp0%[\\/]*([^"%\r\n]+?\.[cm]?js)/i.exec(
      readFileSync(/*turbopackIgnore: true*/ shim, "utf8")
    )
    if (!match) return null
    const entry = path.join(
      /*turbopackIgnore: true*/ path.dirname(shim),
      match[1].replace(/\//g, "\\")
    )
    return existsSync(/*turbopackIgnore: true*/ entry) ? entry : null
  } catch {
    return null
  }
}

/**
 * Static existence check only — no spawn-and-handshake probe, matching what
 * `pi`/`cursorAgent` do. An agent that exists but is not really an ACP server
 * surfaces on the run path instead, where the handshake fails with a real
 * message.
 */
export function hasAcpBinary(command: string): boolean {
  const target = command.trim()
  if (!target) return false
  try {
    if (target.includes("/") || target.includes("\\") || path.isAbsolute(target)) {
      return existsSync(/*turbopackIgnore: true*/ target)
    }
    const names =
      process.platform === "win32"
        ? [target, `${target}.exe`, `${target}.cmd`, `${target}.bat`]
        : [target]
    return pathDirs().some((dir) =>
      names.some((name) =>
        existsSync(
          /*turbopackIgnore: true*/ path.join(
            /*turbopackIgnore: true*/ dir,
            name
          )
        )
      )
    )
  } catch {
    return false
  }
}

/**
 * `$AGENT_UI_DIR/<agentId>` — generated config and agent state live here. The
 * data directory is a runtime value, so the bundler is told not to trace it.
 */
export function acpConfigDir(dataDir: string, agentId: string): string {
  return path.join(/*turbopackIgnore: true*/ dataDir, slug(agentId))
}

/** Keeps a user-chosen agent key from escaping the data directory. */
function slug(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "-")
  // "." and ".." survive the character filter and would name the data
  // directory itself or — worse — its parent.
  return !cleaned || cleaned === "." || cleaned === ".." ? "agent" : cleaned
}

function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
}
