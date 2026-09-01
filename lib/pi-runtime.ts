import "server-only"

import { existsSync } from "node:fs"
import path from "node:path"

/**
 * Locates the `pi` CLI (https://pi.dev) without loading `child_process`, so a
 * request that never reaches the harness — a provider listing, a chat on
 * another backend — does not pull the spawn path in. `lib/pi-agent.ts` owns
 * the process itself.
 */

const UNIX_NAMES = ["pi"]
const WINDOWS_NAMES = ["pi.cmd", "pi.exe", "pi.bat"]

/** Explicit override first, then PATH. Empty `binPath` means "autodetect". */
export function resolvePiCommand(binPath?: string): { cmd: string; args: string[] } {
  const override = (binPath || process.env.PI_BIN || "").trim()
  if (override) return { cmd: override, args: [] }
  return { cmd: process.platform === "win32" ? "pi.cmd" : "pi", args: [] }
}

export function hasPiBinary(binPath?: string): boolean {
  try {
    const override = (binPath || process.env.PI_BIN || "").trim()
    if (override) return existsSync(override)
    return existsOnPath(
      process.platform === "win32" ? WINDOWS_NAMES : UNIX_NAMES
    )
  } catch {
    return false
  }
}

function existsOnPath(names: string[]): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  return dirs.some((dir) => names.some((name) => existsSync(path.join(dir, name))))
}
