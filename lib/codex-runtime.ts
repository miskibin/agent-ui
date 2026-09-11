import "server-only"

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const PACKAGE = "@openai/codex"

export type CodexCommand = { cmd: string; args: string[] }

/**
 * `CODEX_HOME` is the CLI's own override, and is honoured for the same reason
 * the import scanner honours it: a relocated home must not look like a logout.
 */
export function codexHomeDir(): string {
  const configured = (process.env.CODEX_HOME ?? "").trim()
  if (configured) {
    const expanded =
      configured === "~" ||
      configured.startsWith("~/") ||
      configured.startsWith("~\\")
        ? `${homedir()}${configured.slice(1)}`
        : configured
    return path.resolve(expanded)
  }
  return path.join(homedir(), ".codex")
}

/**
 * Whether the CLI already has a login we can see without starting it.
 *
 * `info()` used to spawn `codex app-server` and call `account/read` on every
 * provider list. On Windows that request 401s ChatGPT's account-settings
 * endpoint, the CLI wipes `auth.json`, and Codex Desktop/CLI then loop on
 * login — which is exactly the machine-level hang this function exists to
 * avoid. A missing file is "signed out"; a present one is trusted until a
 * turn proves otherwise.
 */
export function hasCodexCredentials(): boolean {
  if (envSecret("OPENAI_API_KEY") || envSecret("CODEX_API_KEY")) return true
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(codexHomeDir(), "auth.json"), "utf8")
    )
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false
    }
    const record = parsed as Record<string, unknown>
    if (
      typeof record.OPENAI_API_KEY === "string" &&
      record.OPENAI_API_KEY.trim()
    ) {
      return true
    }
    const tokens = record.tokens
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
      return false
    }
    const values = tokens as Record<string, unknown>
    return ["access_token", "refresh_token", "id_token"].some((key) => {
      const value = values[key]
      return typeof value === "string" && value.trim().length > 0
    })
  } catch {
    return false
  }
}

function envSecret(name: string) {
  const value = process.env[name]
  return typeof value === "string" && value.trim().length > 0
}

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
