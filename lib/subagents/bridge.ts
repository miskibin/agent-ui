import "server-only"

import { randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { writeFileAtomic } from "@/lib/atomic-write"
import { MCP_SERVER_NAME } from "@/lib/subagents/mcp"
import { dataDir } from "@/lib/settings/server"
import type { McpServerConfig } from "@/lib/providers/types"

/**
 * Who may drive the subagent bridge, and where it is.
 *
 * `/api/mcp` starts agents in the user's folders, so unlike the rest of the
 * API — which only has to keep *web pages* out (`lib/request-origin`) — it
 * also keeps out every other process on the machine that did not get the
 * token. The token lives in `$AGENT_UI_DIR/bridge.json` (0600) beside the URL
 * the server last answered on, which is how the CLI (`bin/agent-ui.mjs`) and a
 * user-configured `claude mcp add` find a server whose desktop port is picked
 * fresh at every launch.
 */

type BridgeFile = { token: string; url?: string; pid?: number; updatedAt?: number }

const globalState = globalThis as typeof globalThis & {
  __agentUiBridge?: { file?: BridgeFile; loading?: Promise<BridgeFile> }
}
const state = (globalState.__agentUiBridge ??= {})

function bridgePath() {
  return join(/*turbopackIgnore: true*/ dataDir(), "bridge.json")
}

async function load(): Promise<BridgeFile> {
  if (state.file) return state.file
  state.loading ??= (async () => {
    let file: BridgeFile | undefined
    try {
      const parsed = JSON.parse(await readFile(bridgePath(), "utf8")) as BridgeFile
      if (typeof parsed.token === "string" && parsed.token.length >= 32) file = parsed
    } catch {
      /* first run, or a damaged file — mint a new token */
    }
    if (!file) {
      file = { token: randomBytes(32).toString("hex") }
      await save(file)
    }
    state.file = file
    return file
  })()
  try {
    return await state.loading
  } finally {
    state.loading = undefined
  }
}

async function save(file: BridgeFile) {
  await mkdir(dataDir(), { recursive: true })
  await writeFileAtomic(bridgePath(), JSON.stringify(file, null, 2), { mode: 0o600 })
}

export async function bridgeToken(): Promise<string> {
  return (await load()).token
}

/**
 * Records the origin this server answers on. Called from requests the app's
 * own page makes, so the URL is the one that actually reached it.
 */
export async function rememberOrigin(origin: string): Promise<void> {
  const file = await load()
  if (file.url === origin && file.pid === process.pid) return
  const next = { ...file, url: origin, pid: process.pid, updatedAt: Date.now() }
  state.file = next
  try {
    await save(next)
  } catch {
    /* discovery is a convenience; the bridge itself does not depend on it */
  }
}

/** `http://<host>` of the request, normalized to the loopback literal. */
export function requestOrigin(req: Request): string {
  const host = req.headers.get("host")
  if (host) return `http://${host.replace(/^localhost(?=:|$)/, "127.0.0.1")}`
  return new URL(req.url).origin
}

export async function authorized(req: Request): Promise<boolean> {
  const header = req.headers.get("authorization") ?? ""
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  if (!match) return false
  const given = Buffer.from(match[1])
  const expected = Buffer.from(await bridgeToken())
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * The MCP server entry a harness spawned by this app is given: the bridge on
 * this same server, tagged with the chat that is running it so every subagent
 * it starts is filed under that chat and inherits its permission mode.
 */
export async function bridgeServerFor(input: {
  origin: string
  parentId: string
  permissionMode?: string
  harness?: string
  model?: string
  effort?: string
}): Promise<McpServerConfig> {
  const url = new URL("/api/mcp", input.origin)
  url.searchParams.set("parent", input.parentId)
  if (input.permissionMode) url.searchParams.set("mode", input.permissionMode)
  if (input.harness) url.searchParams.set("harness", input.harness)
  if (input.model) url.searchParams.set("model", input.model)
  if (input.effort) url.searchParams.set("effort", input.effort)
  return {
    name: MCP_SERVER_NAME,
    url: url.toString(),
    headers: { Authorization: `Bearer ${await bridgeToken()}` },
  }
}
