import "server-only"

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

import {
  isLocalLoopbackHost,
  loopbackConnectUrls,
} from "@/lib/host-classification"

const READY_TIMEOUT_MS = 5_000
const PROBE_TIMEOUT_MS = 750
const RETRY_MS = 250
/**
 * One spawn per URL per process. `info()` runs on every provider list, and a
 * cooldown would still retry forever — that is the console-window storm on
 * Windows. A later probe can still succeed if the user starts Ollama themselves.
 */
const MAX_SPAWN_ATTEMPTS = 1

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

/**
 * Kept on `globalThis` rather than in module scope: a dev-server recompile
 * re-evaluates this module, and a budget that resets with it is a budget that
 * spawns again after every save.
 */
const state = ((globalThis as { __agentUiOllamaAutostart?: {
  starts: Map<string, Promise<boolean>>
  spawnAttempts: Map<string, number>
} }).__agentUiOllamaAutostart ??= {
  starts: new Map(),
  spawnAttempts: new Map(),
})
const { starts, spawnAttempts } = state

/**
 * `localhost` and `127.0.0.1` are the same server. One key so a hung
 * localhost probe cannot spend a second spawn budget on the IPv4 spelling.
 */
function autostartKey(raw: string) {
  return loopbackConnectUrls(raw)[0] ?? raw.trim().replace(/\/+$/, "")
}

/**
 * Only an http URL that names this machine is ever spawned for. Fail-closed:
 * a URL that will not parse, an https one (a service behind TLS is not one we
 * started) and every remote host answer false, so a remote Ollama is probed
 * and never started. Which hostnames count as this machine is
 * `lib/host-classification` — the whole 127/8, `::1` and the IPv6 spellings of
 * both, not the four strings that used to be spelled out here.
 */
export function isLoopbackOllamaUrl(raw: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== "http:") return false
  return isLocalLoopbackHost(url.hostname)
}

/**
 * Starts the user's local Ollama service only after a request proves it is
 * absent. A shared promise prevents concurrent callers from spawning several
 * processes; a per-URL attempt cap prevents the next provider list from
 * spawning another after the first one failed to become reachable.
 */
export function ensureOllama(
  baseUrl: string,
  deps: OllamaAutostartDependencies = {}
) {
  const normalized = baseUrl.trim().replace(/\/+$/, "")
  if (!isLoopbackOllamaUrl(normalized)) return Promise.resolve(false)
  const key = autostartKey(normalized)
  const existing = starts.get(key)
  if (existing) return existing
  const pending = startAndWait(normalized, key, deps).finally(() => {
    starts.delete(key)
  })
  starts.set(key, pending)
  return pending
}

async function startAndWait(
  baseUrl: string,
  key: string,
  deps: OllamaAutostartDependencies
) {
  const fetchImpl = deps.fetchImpl ?? fetch
  if (await reachable(baseUrl, fetchImpl)) return true
  if ((spawnAttempts.get(key) ?? 0) >= MAX_SPAWN_ATTEMPTS) return false

  spawnAttempts.set(key, (spawnAttempts.get(key) ?? 0) + 1)
  const spawnImpl = deps.spawnImpl ?? spawn
  const platform = deps.platform ?? process.platform
  let launchFailed = false
  try {
    const child = spawnImpl(/*turbopackIgnore: true*/ ollamaCommand(platform), ["serve"], {
      // `DETACHED_PROCESS` on Windows makes `CREATE_NO_WINDOW` a no-op, so a
      // detached `ollama serve` always gets its own console.
      detached: platform !== "win32",
      stdio: "ignore",
      env: {
        ...process.env,
        OLLAMA_HOST: ollamaHost(baseUrl),
      },
      ...(platform === "win32" ? { windowsHide: true } : {}),
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
  const url = new URL(loopbackConnectUrls(baseUrl)[0] ?? baseUrl)
  const host = url.hostname === "::1" || url.hostname === "[::1]"
    ? "[::1]"
    : url.hostname
  return host + ":" + (url.port || "11434")
}

async function reachable(baseUrl: string, fetchImpl: FetchLike) {
  for (const candidate of loopbackConnectUrls(baseUrl)) {
    try {
      const response = await fetchImpl(`${candidate}/api/tags`, {
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (response.ok) return true
    } catch {
      /* try the next loopback spelling */
    }
  }
  return false
}

/**
 * Gives one URL its spawn back — for an explicit "try again" from the user,
 * never for a background probe, which is exactly the retry storm the budget
 * exists to stop.
 */
export function allowOllamaRespawn(baseUrl: string) {
  spawnAttempts.delete(autostartKey(baseUrl.trim().replace(/\/+$/, "")))
}

/** Testing seam: forgets in-flight starts and the per-URL spawn budget. */
export function resetOllamaAutostart() {
  starts.clear()
  spawnAttempts.clear()
}
