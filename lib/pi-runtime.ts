import "server-only"

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Locates the `pi` CLI (https://pi.dev) without loading `child_process`, so a
 * request that never reaches the harness — a provider listing, a chat on
 * another backend — does not pull the spawn path in. `lib/pi-agent.ts` owns
 * the process itself.
 */

const PI_PACKAGE = "@earendil-works/pi-coding-agent"
const UNIX_NAMES = ["pi"]
const WINDOWS_NAMES = ["pi.exe", "pi.cmd", "pi.bat"]

export type PiCommand = { cmd: string; args: string[] }

/** Explicit override first, then PATH. Empty `binPath` means "autodetect". */
export function resolvePiCommand(binPath?: string): PiCommand {
  const override = (binPath || process.env.PI_BIN || "").trim()
  if (override) return commandFor(override)
  if (process.platform === "win32") {
    return resolveWindowsInstall() ?? { cmd: "pi.cmd", args: [] }
  }
  return { cmd: "pi", args: [] }
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

/** A JS entry point needs a Node to run it; anything else is executable. */
function commandFor(target: string): PiCommand {
  return target.endsWith(".js")
    ? { cmd: process.execPath, args: [target] }
    : { cmd: target, args: [] }
}

/**
 * On Windows `npm i -g` installs pi as a `pi.cmd` shim, and Node refuses to
 * spawn `.cmd`/`.bat` without a shell (EINVAL, ever since the fix for
 * CVE-2024-27980). Running it through a shell instead would mean passing the
 * prompt through `cmd.exe` quoting, so we look past the shim for the JS entry
 * point it wraps and run that with the Node we are already inside.
 */
function resolveWindowsInstall(): PiCommand | null {
  for (const dir of pathDirs()) {
    const exe = path.join(dir, "pi.exe")
    if (existsSync(exe)) return { cmd: exe, args: [] }
    if (!existsSync(path.join(dir, "pi.cmd"))) continue
    const entry = packageEntry(dir)
    if (entry) return { cmd: process.execPath, args: [entry] }
  }
  return null
}

/** The shim's sibling `node_modules`, read through the package's own `bin`. */
function packageEntry(dir: string): string | null {
  const pkgDir = path.join(dir, "node_modules", ...PI_PACKAGE.split("/"))
  const manifest = path.join(pkgDir, "package.json")
  if (!existsSync(manifest)) return null
  try {
    const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as {
      bin?: string | Record<string, string>
    }
    const relative = typeof bin === "string" ? bin : bin?.pi
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
