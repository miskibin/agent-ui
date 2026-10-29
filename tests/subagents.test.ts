import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  buildArgs,
  mcpConfigJson,
  permissionArgs,
} from "@/lib/claude-code-protocol"
import { nestUnderParents } from "@/lib/session-groups"
import type { SessionMeta } from "@/lib/store/types"
import {
  BRIDGE_CALL_TIMEOUT_MS,
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  DEFAULT_ANSWER_CHARS,
  DEFAULT_WAIT_ANSWER_CHARS,
  handleRpc,
  parseMessageArgs,
  parseRunArgs,
  type MessageSubagentArgs,
  type RunSubagentArgs,
  type WaitSubagentsArgs,
  type SubagentTools,
} from "@/lib/subagents/mcp"

function fakeTools(calls: unknown[] = []): SubagentTools {
  return {
    listHarnesses: async () => [{ id: "pi", available: true }],
    listModels: async (harness) => [{ id: `${harness}/m` }],
    run: async (args: RunSubagentArgs) => {
      calls.push(args)
      return { status: "done", answer: "42", run_id: "r1" }
    },
    message: async (args) => {
      calls.push(args)
      return { status: "queued", run_id: "r2" }
    },
    status: async (ref, wait, view) => ({ ...ref, wait, view }),
    wait: async (args) => {
      calls.push(args)
      return { runs: [] }
    },
    cancel: async (runId) => ({ run_id: runId, cancelled: true }),
    list: async () => [],
  }
}

describe("subagent MCP server", () => {
  test("negotiates a protocol version it knows, else its newest", async () => {
    const known = await handleRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      fakeTools()
    )
    assert.equal((known as { result: { protocolVersion: string } }).result.protocolVersion, "2025-03-26")
    const unknown = await handleRpc(
      { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      fakeTools()
    )
    assert.equal((unknown as { result: { protocolVersion: string } }).result.protocolVersion, "2025-06-18")
  })

  test("a notification gets no answer", async () => {
    assert.equal(
      await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, fakeTools()),
      null
    )
  })

  test("lists the tools and rejects unknown methods", async () => {
    const list = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, fakeTools())) as {
      result: { tools: { name: string }[] }
    }
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      [
        "list_harnesses",
        "list_models",
        "run_subagent",
        "get_subagent",
        "wait_subagents",
        "message_subagent",
        "cancel_subagent",
        "list_subagents",
      ]
    )
    const missing = (await handleRpc({ jsonrpc: "2.0", id: 2, method: "nope" }, fakeTools())) as {
      error: { code: number }
    }
    assert.equal(missing.error.code, -32601)
  })

  test("run_subagent answers with the result as text and structured content", async () => {
    const calls: unknown[] = []
    const answer = (await handleRpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "run_subagent", arguments: { harness: "pi", prompt: "do it", wait_seconds: 5 } },
      },
      fakeTools(calls)
    )) as { result: { content: { text: string }[]; structuredContent: { answer: string }; isError?: boolean } }
    assert.equal(answer.result.structuredContent.answer, "42")
    // Compact JSON: indentation is context the orchestrator pays for.
    assert.equal(answer.result.content[0].text, JSON.stringify({ status: "done", answer: "42", run_id: "r1" }))
    assert.equal(answer.result.isError, undefined)
    assert.equal((calls[0] as RunSubagentArgs).waitSeconds, 5)
  })

  test("a bad call is a tool error the model can read, never a throw", async () => {
    const tools = fakeTools()
    tools.run = async () => {
      throw new Error("Unknown or disabled harness")
    }
    const answer = (await handleRpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "run_subagent", arguments: { harness: "x", prompt: "y" } },
      },
      tools
    )) as { result: { isError: boolean; content: { text: string }[] } }
    assert.equal(answer.result.isError, true)
    assert.match(answer.result.content[0].text, /Unknown or disabled harness/)
  })
})

describe("orchestration tools", () => {
  const call = (name: string, args: unknown, tools = fakeTools()) =>
    handleRpc(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } },
      tools
    ) as Promise<{ result: { structuredContent: Record<string, unknown>; isError?: boolean; content: { text: string }[] } }>

  test("get_subagent takes a run id or a session id, and reads the view", async () => {
    const answer = await call("get_subagent", { session_id: "s1", detail: "full", since_step: 4 })
    assert.deepEqual(answer.result.structuredContent, {
      sessionId: "s1",
      wait: 0,
      view: { detail: "full", sinceStep: 4, maxAnswerChars: DEFAULT_ANSWER_CHARS },
    })
    const missing = await call("get_subagent", {})
    assert.equal(missing.result.isError, true)
  })

  test("message_subagent needs a target and a message", async () => {
    const calls: unknown[] = []
    await call("message_subagent", { run_id: "r1", message: "also fix the tests", interrupt: true }, fakeTools(calls))
    const args = calls[0] as MessageSubagentArgs
    assert.equal(args.runId, "r1")
    assert.equal(args.interrupt, true)
    assert.equal(args.background, false)
    assert.equal((await call("message_subagent", { run_id: "r1" })).result.isError, true)
    assert.equal((await call("message_subagent", { message: "x" })).result.isError, true)
  })

  test("wait_subagents defaults to any, always brief, ids cleaned", async () => {
    const calls: unknown[] = []
    await call("wait_subagents", { run_ids: ["r1", "", 3, "r2"], detail: "full" }, fakeTools(calls))
    const args = calls[0] as WaitSubagentsArgs
    assert.deepEqual(args.runIds, ["r1", "r2"])
    assert.equal(args.mode, "any")
    assert.equal(args.view.detail, "brief")
    assert.equal(args.view.maxAnswerChars, DEFAULT_WAIT_ANSWER_CHARS)
    assert.equal(args.waitSeconds, DEFAULT_WAIT_SECONDS)
  })

  test("no single call may block past what the clients wait for", () => {
    // Node's fetch (the stdio proxy) gives up after 300s without headers.
    assert.ok(MAX_WAIT_SECONDS < 300)
    const message = parseMessageArgs({ session_id: "s", message: "m", wait_seconds: 900 }) as MessageSubagentArgs
    assert.equal(message.waitSeconds, MAX_WAIT_SECONDS)
  })
})

describe("parseRunArgs", () => {
  test("requires a prompt and allows inheriting the harness", () => {
    assert.equal(typeof parseRunArgs({ prompt: "x" }), "object")
    assert.equal(typeof parseRunArgs({ harness: "pi", prompt: "   " }), "string")
  })

  test("defaults and caps the wait, and reads snake_case", () => {
    const args = parseRunArgs({ harness: "pi", prompt: "x", session_id: "s1" }) as RunSubagentArgs
    assert.equal(args.waitSeconds, DEFAULT_WAIT_SECONDS)
    assert.equal(args.sessionId, "s1")
    assert.equal(args.background, false)
    const capped = parseRunArgs({ harness: "pi", prompt: "x", wait_seconds: 1e9 }) as RunSubagentArgs
    assert.equal(capped.waitSeconds, MAX_WAIT_SECONDS)
    const timed = parseRunArgs({ harness: "pi", prompt: "x", timeout_seconds: 90 }) as RunSubagentArgs
    assert.equal(timed.timeoutSeconds, 90)
    assert.equal(
      (parseRunArgs({ harness: "pi", prompt: "x", timeout_seconds: -1 }) as RunSubagentArgs).timeoutSeconds,
      undefined
    )
  })
})

describe("nestUnderParents", () => {
  const meta = (id: string, parentId?: string) =>
    ({ meta: { id, ...(parentId ? { parentId } : null) } as SessionMeta })

  test("puts each child right under its parent, keeping the order otherwise", () => {
    const order = nestUnderParents([
      meta("c1", "p"),
      meta("a"),
      meta("p"),
      meta("c2", "p"),
      meta("b"),
    ]).map((entry) => entry.meta.id)
    assert.deepEqual(order, ["a", "p", "c1", "c2", "b"])
  })

  test("a child whose parent is elsewhere stays put", () => {
    const order = nestUnderParents([meta("a"), meta("c", "gone")]).map((entry) => entry.meta.id)
    assert.deepEqual(order, ["a", "c"])
  })
})

describe("claude-code and the bridge", () => {
  test("an attached MCP server is configured from a file and allowed", () => {
    const args = buildArgs({
      permissionMode: "edits",
      mcpConfigPath: "/tmp/agent-ui/mcp.json",
      mcpServerNames: ["agent-ui"],
    })
    assert.deepEqual(args.slice(-6), [
      "--mcp-config",
      "/tmp/agent-ui/mcp.json",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "mcp__agent-ui",
    ])
    // The token must never ride in argv.
    assert.ok(!args.some((arg) => arg.includes("Bearer")))
  })

  test("read-only keeps its deny list and allows only the bridge", () => {
    assert.deepEqual(permissionArgs("read-only", ["mcp__agent-ui"]).slice(-2), [
      "--allowedTools",
      "mcp__agent-ui",
    ])
    assert.equal(permissionArgs("full", ["mcp__agent-ui"]).at(-1), "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,mcp__agent-ui")
  })

  test("the config document is Claude Code's http server shape", () => {
    assert.deepEqual(
      JSON.parse(mcpConfigJson([{ name: "agent-ui", url: "http://127.0.0.1:1/api/mcp", headers: { Authorization: "Bearer t" } }])),
      {
        mcpServers: {
          "agent-ui": {
            type: "http",
            url: "http://127.0.0.1:1/api/mcp",
            headers: { Authorization: "Bearer t" },
          },
        },
      }
    )
  })

  test("a server that blocks gets a timeout past Claude Code's 60s default", () => {
    const doc = JSON.parse(
      mcpConfigJson([{ name: "agent-ui", url: "http://127.0.0.1:1/api/mcp", timeoutMs: 300_000 }])
    )
    assert.equal(doc.mcpServers["agent-ui"].timeout, 300_000)
  })

  test("the bridge's timeout outlasts its longest wait", () => {
    assert.ok(BRIDGE_CALL_TIMEOUT_MS > MAX_WAIT_SECONDS * 1000)
    // Past 300s Claude Code also disables its HTTP client's own limit.
    assert.ok(BRIDGE_CALL_TIMEOUT_MS <= 300_000)
  })
})
