#!/usr/bin/env node
/**
 * agent-ui — the command line onto a running Agent UI's subagent bridge.
 *
 * Every command is a call to the app's MCP endpoint (`/api/mcp`), found
 * through `$AGENT_UI_DIR/bridge.json`, which the server rewrites with its
 * current URL and keeps the bridge token in. So a subagent started from here
 * is the same thing one started by an agent inside the app is: a chat in the
 * window, streaming live, persisted.
 *
 *   agent-ui harnesses
 *   agent-ui models <harness>
 *   agent-ui run <harness> [--model m] [--cwd dir] [--title t] [--session id]
 *                [--background] [--wait seconds] [--json] <prompt… | ->
 *   agent-ui status <run-id> [--wait seconds] [--json]
 *   agent-ui cancel <run-id>
 *   agent-ui list
 *   agent-ui mcp            stdio MCP server proxying to the running app
 *   agent-ui mcp-config     how to register it with Claude Code
 *
 * `agent-ui mcp` is what an agent *outside* the app (a Claude Code in your
 * terminal) should be given: the desktop app picks a fresh port at every
 * launch, and the proxy re-reads bridge.json per message, so the registration
 * never goes stale.
 *
 * No dependencies — Node 18+ only.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const SELF = fileURLToPath(import.meta.url)

function dataDir() {
  return process.env.AGENT_UI_DIR || join(homedir(), ".agent-ui")
}

function bridge() {
  let file
  try {
    file = JSON.parse(readFileSync(join(dataDir(), "bridge.json"), "utf8"))
  } catch {
    throw new Error(
      `No ${join(dataDir(), "bridge.json")} — start Agent UI first (open it once so it can record its address).`
    )
  }
  const url = process.env.AGENT_UI_URL || file.url
  if (!url) throw new Error("Agent UI has not recorded its address yet — open its window once.")
  return { url: new URL("/api/mcp", url).toString(), token: file.token }
}

let nextId = 1

async function rpc(method, params) {
  const { url, token } = bridge()
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  }).catch((err) => {
    throw new Error(`Agent UI is not answering at ${url} (${err.message}). Is it running?`)
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Agent UI answered ${res.status}`)
  if (body.error) throw new Error(body.error.message)
  return body.result
}

async function tool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args })
  const data =
    result.structuredContent ?? result.content?.map((part) => part.text).join("\n")
  if (result.isError) {
    throw new Error(typeof data === "string" ? data : JSON.stringify(data))
  }
  return data
}

function parseFlags(argv) {
  const flags = {}
  const rest = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--background" || arg === "--json") flags[arg.slice(2)] = true
    else if (arg.startsWith("--")) flags[arg.slice(2)] = argv[++index]
    else rest.push(arg)
  }
  return { flags, rest }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Everything printed here came from an agent or a server, so it is written
 * with every control character but newline and tab removed: an answer must
 * not be able to move the cursor, retitle the terminal or rewrite what was
 * printed before it with escape sequences.
 */
function clean(text) {
  return String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
}

function out(text) {
  process.stdout.write(`${clean(text)}\n`)
}

function note(text) {
  process.stderr.write(`${clean(text)}\n`)
}

function print(data, json) {
  if (json || typeof data !== "object") {
    out(typeof data === "string" ? data : JSON.stringify(data, null, 2))
    return
  }
  if (typeof data.answer === "string") {
    out(data.answer)
    note(`\n[${data.status} · ${data.harness} · session ${data.session_id} · run ${data.run_id}]`)
    return
  }
  out(JSON.stringify(data, null, 2))
}

/** stdin/stdout MCP server forwarding every message to the running app. */
async function stdioProxy() {
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const isRequest = message.id !== undefined && message.id !== null
    try {
      const { url, token } = bridge()
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: line,
      })
      if (!isRequest) continue
      const body = await res.json()
      process.stdout.write(`${JSON.stringify(body)}\n`)
    } catch (err) {
      if (!isRequest) continue
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: `Agent UI is not reachable: ${err.message}` },
        })}\n`
      )
    }
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  const { flags, rest } = parseFlags(argv)
  switch (command) {
    case "harnesses": {
      const data = await tool("list_harnesses")
      if (flags.json) return print(data, true)
      for (const h of data.harnesses) {
        const reason = h.available ? "" : `  (${h.unavailable_reason ?? "unavailable"})`
        out(`${h.available ? "●" : "○"} ${h.id.padEnd(24)} ${h.name}${reason}`)
      }
      return
    }
    case "models": {
      if (!rest[0]) throw new Error("usage: agent-ui models <harness>")
      const data = await tool("list_models", { harness: rest[0] })
      if (flags.json) return print(data, true)
      for (const m of data.models) {
        const name = m.name && m.name !== m.id ? `  — ${m.name}` : ""
        out(`${m.id}${name}`)
      }
      return
    }
    case "run": {
      const [harness, ...words] = rest
      let prompt = words.join(" ")
      if (!prompt || prompt === "-") prompt = await readStdin()
      if (!harness || !prompt.trim()) {
        throw new Error("usage: agent-ui run <harness> [flags] <prompt… | ->")
      }
      const data = await tool("run_subagent", {
        harness,
        prompt,
        model: flags.model,
        cwd: flags.cwd ? resolve(flags.cwd) : process.cwd(),
        title: flags.title,
        session_id: flags.session,
        background: !!flags.background,
        ...(flags.wait ? { wait_seconds: Number(flags.wait) } : null),
      })
      print(data, flags.json)
      if (data.status === "error") process.exitCode = 1
      return
    }
    case "status": {
      if (!rest[0]) throw new Error("usage: agent-ui status <run-id> [--wait s]")
      print(
        await tool("get_subagent", { run_id: rest[0], wait_seconds: Number(flags.wait ?? 0) }),
        flags.json
      )
      return
    }
    case "cancel": {
      if (!rest[0]) throw new Error("usage: agent-ui cancel <run-id>")
      print(await tool("cancel_subagent", { run_id: rest[0] }), true)
      return
    }
    case "list":
      print(await tool("list_subagents"), true)
      return
    case "mcp":
      return stdioProxy()
    case "mcp-config": {
      const cmd = `claude mcp add --scope user agent-ui -- node ${JSON.stringify(SELF)} mcp`
      console.log(`Register the bridge with Claude Code (once):\n\n  ${cmd}\n`)
      console.log("Chats started inside Agent UI get it automatically; this is for a Claude Code you run yourself.")
      return
    }
    default:
      console.log(readFileSync(SELF, "utf8").split("\n").slice(2, 19).map((l) => l.replace(/^ \*\s?/, "")).join("\n"))
      if (command && command !== "help" && command !== "--help") process.exitCode = 1
  }
}

main().catch((err) => {
  note(`agent-ui: ${err.message}`)
  process.exitCode = 1
})
