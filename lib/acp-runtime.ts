import "server-only"

import { existsSync } from "node:fs"
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

/** A JS entry point needs a Node to run it; anything else is executable. */
export function resolveAcpCommand(command: string, args: string[]): AcpCommand {
  const target = command.trim()
  return target.endsWith(".js")
    ? { cmd: process.execPath, args: [target, ...args] }
    : { cmd: target, args: [...args] }
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
      return existsSync(target)
    }
    const names =
      process.platform === "win32"
        ? [target, `${target}.exe`, `${target}.cmd`, `${target}.bat`]
        : [target]
    return pathDirs().some((dir) =>
      names.some((name) => existsSync(path.join(dir, name)))
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
  return value.replace(/[^a-zA-Z0-9._-]/g, "-") || "agent"
}

function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
}
