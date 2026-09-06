import "server-only"

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

const READY_TIMEOUT_MS = 5_000
const PROBE_TIMEOUT_MS = 750
const RETRY_MS = 250
const FAILURE_COOLDOWN_MS = 10_000

type SpawnLike = (
  command: string,
  args: string[],
  options: {
    detached: boolean
    stdio: "ignore"
    env: NodeJS.ProcessEnv
    windowsHide?: boolean
  }
) => { once(event: "error", listener: () => void): unknown; unref(): unknown }
type FetchLike = typeof fetch

export type OllamaAutostartDependencies = {
  fetchImpl?: FetchLike
  spawnImpl?: SpawnLike
  platform?: NodeJS.Platform
}

const starts = new Map<string, Promise<boolean>>()
const failures = new Map<string, number>()

export function isLoopbackOllamaUrl(raw: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== "http:") return false
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  )
}

/**
 * Starts the user's local Ollama service only after a request proves it is
 * absent. A shared promise prevents concurrent model requests from spawning
 * several Ollama processes.
 */
export function ensureOllama(
  baseUrl: string,
  deps: OllamaAutostartDependencies = {}
) {
  const normalized = baseUrl.trim().replace(/\/+$/, "")
  if (!isLoopbackOllamaUrl(normalized)) return Promise.resolve(false)
  const failedAt = failures.get(normalized)
  if (failedAt && Date.now() - failedAt < FAILURE_COOLDOWN_MS) {
    return Promise.resolve(false)
  }
  const existing = starts.get(normalized)
  if (existing) return existing
  const pending = startAndWait(normalized, deps)
    .then((ok) => {
      if (ok) failures.delete(normalized)
      else failures.set(normalized, Date.now())
      return ok
    })
    .finally(() => starts.delete(normalized))
  starts.set(normalized, pending)
  return pending
}

async function startAndWait(
  baseUrl: string,
  deps: OllamaAutostartDependencies
) {
  const fetchImpl = deps.fetchImpl ?? fetch
  if (await reachable(baseUrl, fetchImpl)) return true

  const spawnImpl = deps.spawnImpl ?? spawn
  let launchFailed = false
  try {
    const child = spawnImpl(/*turbopackIgnore: true*/ ollamaCommand(deps.platform), ["serve"], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        OLLAMA_HOST: ollamaHost(baseUrl),
      },
      ...(deps.platform === "win32" || process.platform === "win32"
        ? { windowsHide: true }
        : {}),
    })
    child.once("error", () => {
      launchFailed = true
    })
    child.unref()
  } catch {
    return false
  }

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (launchFailed) return false
    if (await reachable(baseUrl, fetchImpl)) return true
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
  }
  return false
}

function ollamaCommand(platform = process.platform) {
  if (platform !== "win32") return "ollama"
  const localAppData = process.env.LOCALAPPDATA
  const installed = localAppData
    ? path.join(/*turbopackIgnore: true*/ localAppData, "Programs", "Ollama", "ollama.exe")
    : ""
  return installed && existsSync(/*turbopackIgnore: true*/ installed)
    ? installed
    : "ollama"
}

function ollamaHost(baseUrl: string) {
  const url = new URL(baseUrl)
  const host = url.hostname === "::1" || url.hostname === "[::1]"
    ? "[::1]"
    : url.hostname
  return host + ":" + (url.port || "11434")
}

async function reachable(baseUrl: string, fetchImpl: FetchLike) {
  try {
    const response = await fetchImpl(`${baseUrl}/api/tags`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}
