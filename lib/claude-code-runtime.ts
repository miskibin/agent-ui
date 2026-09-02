import "server-only"

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Locates the Claude Code CLI (`claude`) without loading `child_process`, so a
 * request that never reaches the harness — a provider listing, a chat on
 * another backend — does not pull the spawn path in. `lib/claude-code-agent.ts`
 * owns the process itself.
 */

const CLAUDE_PACKAGE = "@anthropic-ai/claude-code"
const UNIX_NAMES = ["claude"]
const WINDOWS_NAMES = ["claude.exe", "claude.cmd", "claude.bat"]

export type ClaudeCodeCommand = { cmd: string; args: string[] }

/** Explicit override first, then PATH. Empty `binPath` means "autodetect". */
export function resolveClaudeCodeCommand(binPath?: string): ClaudeCodeCommand {
  const override = (binPath || process.env.CLAUDE_CODE_BIN || "").trim()
  if (override) return commandFor(override)
  if (process.platform === "win32") {
    return resolveWindowsInstall() ?? { cmd: "claude.cmd", args: [] }
  }
  return { cmd: "claude", args: [] }
}

export function hasClaudeCodeBinary(binPath?: string): boolean {
  try {
    const override = (binPath || process.env.CLAUDE_CODE_BIN || "").trim()
    if (override) return existsSync(override)
    return existsOnPath(
      process.platform === "win32" ? WINDOWS_NAMES : UNIX_NAMES
    )
  } catch {
    return false
  }
}

/** A JS entry point needs a Node to run it; anything else is executable. */
function commandFor(target: string): ClaudeCodeCommand {
  return target.endsWith(".js")
    ? { cmd: process.execPath, args: [target] }
    : { cmd: target, args: [] }
}

/**
 * The same trap `pi` hits on Windows: `npm i -g` leaves a `claude.cmd` shim,
 * and Node has refused to spawn `.cmd`/`.bat` without a shell ever since the
 * fix for CVE-2024-27980. Going through a shell would mean pushing our
 * arguments through `cmd.exe` quoting, so look past the shim for the JS entry
 * point it wraps and run that with the Node we are already inside.
 */
function resolveWindowsInstall(): ClaudeCodeCommand | null {
  for (const dir of pathDirs()) {
    const exe = path.join(dir, "claude.exe")
    if (existsSync(exe)) return { cmd: exe, args: [] }
    if (!existsSync(path.join(dir, "claude.cmd"))) continue
    const entry = packageEntry(dir)
    if (entry) return { cmd: process.execPath, args: [entry] }
  }
  return null
}

/** The shim's sibling `node_modules`, read through the package's own `bin`. */
function packageEntry(dir: string): string | null {
  const pkgDir = path.join(dir, "node_modules", ...CLAUDE_PACKAGE.split("/"))
  const manifest = path.join(pkgDir, "package.json")
  if (!existsSync(manifest)) return null
  try {
    const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as {
      bin?: string | Record<string, string>
    }
    const relative = typeof bin === "string" ? bin : bin?.claude
    if (!relative) return null
    const entry = path.join(pkgDir, relative)
    return existsSync(entry) ? entry : null
  } catch {
    return null
  }
}

function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
}

function existsOnPath(names: string[]): boolean {
  return pathDirs().some((dir) =>
    names.some((name) => existsSync(path.join(dir, name)))
  )
}
