import "server-only"

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const PACKAGE = "@openai/codex"

export type CodexCommand = { cmd: string; args: string[] }

export function resolveCodexCommand(binPath?: string): CodexCommand {
  const target = (binPath || process.env.CODEX_BIN || "").trim()
  if (target) return commandFor(target)
  if (process.platform !== "win32") return { cmd: "codex", args: [] }
  for (const dir of pathDirs()) {
    const exe = path.join(dir, "codex.exe")
    if (existsSync(exe)) return { cmd: exe, args: [] }
    if (existsSync(path.join(dir, "codex.cmd"))) {
      const entry = packageEntry(dir)
      if (entry) return { cmd: process.execPath, args: [entry] }
    }
  }
  return { cmd: "codex.exe", args: [] }
}

export function hasCodexBinary(binPath?: string): boolean {
  try {
    const target = (binPath || process.env.CODEX_BIN || "").trim()
    if (target) return existsSync(target)
    return pathDirs().some((dir) =>
      ["codex", "codex.exe", "codex.cmd"].some((name) =>
        existsSync(path.join(dir, name))
      )
    )
  } catch {
    return false
  }
}

function commandFor(target: string): CodexCommand {
  if (/\.(?:cmd|bat)$/i.test(target)) {
    const entry = packageEntry(path.dirname(target))
    if (entry) return { cmd: process.execPath, args: [entry] }
  }
  return /\.[cm]?js$/i.test(target)
    ? { cmd: process.execPath, args: [target] }
    : { cmd: target, args: [] }
}

function packageEntry(dir: string): string | null {
  const packageDir = path.join(dir, "node_modules", ...PACKAGE.split("/"))
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf8")
    ) as { bin?: string | Record<string, string> }
    const relative =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.codex
    if (!relative) return null
    const entry = path.join(packageDir, relative)
    return existsSync(entry) ? entry : null
  } catch {
    return null
  }
}

function pathDirs() {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
}
