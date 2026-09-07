import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"

import { compareVersions, versionParts } from "@/lib/agent-runtime"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import {
  mapToolEvent,
  readUsage,
  type CursorCliEvent,
} from "@/lib/cursor-agent"

/**
 * Fixtures are trimmed from real output of
 * `agent -p --output-format stream-json --stream-partial-output` (CLI
 * 2026.09.02-c22c1a3) against a scratch repo: key names and nesting are
 * verbatim, with only the fields nothing reads dropped.
 *
 * The two exported translators are pure, so everything below runs without the
 * binary. `runCursorAgent` itself is the spawn and the streaming state around
 * them, and is exercised live rather than here.
 */

/** Every call arrives with the CLI's bookkeeping beside the call itself. */
function toolCall(
  key: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  return {
    [key]: payload,
    hookAdditionalContexts: [],
    toolCallId: "call-1\nfc_1_0",
    startedAtMs: "1788760079766",
    ...extra,
  }
}

function completed(tool_call: Record<string, unknown>): CursorCliEvent {
  return {
    type: "tool_call",
    subtype: "completed",
    call_id: "call-1\nfc_1_0",
    tool_call,
  }
}

test("a shell call reports the exit status the CLI published", () => {
  const event = mapToolEvent(
    completed(
      toolCall("shellToolCall", {
        args: { command: 'node -e "console.log(1+1)"', timeout: 30000 },
        result: {
          success: {
            command: 'node -e "console.log(1+1)"',
            exitCode: 0,
            signal: "",
            stdout: "2\n",
            stderr: "",
          },
        },
      })
    )
  )
  assert.equal(event.type, "tool")
  if (event.type !== "tool") return
  assert.equal(event.name, "Shell")
  assert.equal(event.status, "done")
  assert.equal(event.exitCode, 0)
  // What the command printed — not the payload wrapped around it.
  assert.equal(event.output, "2")
})

test("a failing command keeps its output and its non-zero code", () => {
  const event = mapToolEvent(
    completed(
      toolCall("shellToolCall", {
        args: { command: "npm test" },
        result: {
          success: {
            exitCode: 1,
            stdout: "1 passing\n",
            stderr: "1 failing\n",
          },
        },
      })
    )
  )
  if (event.type !== "tool") return assert.fail("expected a tool event")
  assert.equal(event.exitCode, 1)
  assert.equal(event.output, "1 passing\n1 failing")
  // The call itself succeeded: `status` says whether the tool ran, and only
  // `exitCode` tells "the tests ran and failed" from "the tool broke".
  assert.equal(event.status, "done")
})

test("a command that printed nothing still says how it ended", () => {
  const event = mapToolEvent(
    completed(
      toolCall("shellToolCall", {
        args: { command: "true" },
        result: { success: { exitCode: 0, stdout: "", stderr: "" } },
      })
    )
  )
  if (event.type !== "tool") return assert.fail("expected a tool event")
  assert.equal(event.output, "exit 0")
})

test("a started call has neither output nor an exit code yet", () => {
  const event = mapToolEvent({
    type: "tool_call",
    subtype: "started",
    call_id: "call-1\nfc_1_0",
    tool_call: toolCall("shellToolCall", { args: { command: "npm test" } }),
  })
  if (event.type !== "tool") return assert.fail("expected a tool event")
  assert.equal(event.status, "running")
  assert.equal(event.output, undefined)
  assert.equal(event.exitCode, undefined)
})

test("a tool with no exit code publishes none", () => {
  const event = mapToolEvent(
    completed(
      toolCall("readToolCall", {
        args: { path: "C:\\repo\\math.js" },
        result: { success: { totalLines: 6, content: "export const a = 1\n" } },
      })
    )
  )
  if (event.type !== "tool") return assert.fail("expected a tool event")
  assert.equal(event.name, "Read")
  assert.equal(event.exitCode, undefined)
  assert.match(event.output ?? "", /^6 lines\n/)
})

test("the call is found by name, not by key order", () => {
  // `hookAdditionalContexts` sits beside the call and JSON key order is not a
  // contract; naming the first key would title the row "Hook Additional
  // Contexts" and lose both the arguments and the result.
  const event = mapToolEvent(
    completed({
      hookAdditionalContexts: [],
      toolCallId: "call-1\nfc_1_0",
      globToolCall: {
        args: { globPattern: "**/math.js" },
        result: { success: { files: [".\\math.js"], totalFiles: 1 } },
      },
    })
  )
  if (event.type !== "tool") return assert.fail("expected a tool event")
  assert.equal(event.name, "Glob")
  assert.match(event.input ?? "", /globPattern/)
})

test("a completed edit folds the unified diff into its arguments", () => {
  const event = mapToolEvent(
    completed(
      toolCall("editToolCall", {
        args: { path: "C:\\repo\\README.md", streamContent: "# hello" },
        result: {
          success: {
            diffString: "--- a/README.md\n+++ b/README.md\n+# hello\n",
            linesAdded: 2,
            linesRemoved: 0,
          },
        },
      })
    )
  )
  if (event.type !== "tool") return assert.fail("expected a tool event")
  const args = JSON.parse(event.input ?? "{}") as Record<string, unknown>
  assert.match(String(args.diff), /\+# hello/)
  assert.equal(args.streamContent, undefined)
  assert.equal(event.output, "+2")
})

test("a failed call is an error row", () => {
  const event = mapToolEvent(
    completed(
      toolCall("readToolCall", {
        args: { path: "C:\\repo\\missing.txt" },
        result: { error: "no such file" },
      })
    )
  )
  if (event.type !== "tool") return assert.fail("expected a tool event")
  assert.equal(event.status, "error")
})

test("the result's token counts reach the turn, cache reads excluded", () => {
  assert.deepEqual(
    readUsage({
      type: "result",
      usage: {
        inputTokens: 13405,
        outputTokens: 141,
        cacheReadTokens: 23936,
        cacheWriteTokens: 0,
      },
    }),
    { input: 13405, output: 141 }
  )
})

test("a result with no usage block reports nothing", () => {
  assert.equal(readUsage({ type: "result" }), undefined)
  assert.equal(readUsage({ type: "result", usage: { requestId: "x" } }), undefined)
})

test("the newest Windows bundle is picked by number, not by code point", () => {
  assert.deepEqual(versionParts("2026.09.02-c22c1a3"), [2026, 9, 2])
  assert.equal(versionParts("4203b224-e12b-4af3.zip"), null)
  // The CLI does not promise to zero-pad, and a string sort would pin the app
  // to the older bundle in both of these.
  assert.ok(compareVersions([2026, 10, 1], [2026, 9, 2]) > 0)
  assert.ok(compareVersions([2026, 8, 11], [2026, 8, 5]) > 0)
  assert.equal(compareVersions([2026, 9, 2], [2026, 9, 2]), 0)
})

/* -------------------------------------------------------------------------- */
/*                       the streaming turn, end to end                       */
/* -------------------------------------------------------------------------- */

/**
 * `runCursorAgent` is the spawn and the state machine around the translators
 * above, and the three things asserted below only exist in that state machine:
 * a reply that is nothing but a transport diagnostic must fail the turn rather
 * than be stored as the answer, and a turn that ends underneath a running tool
 * call must close its row instead of leaving it spinning forever.
 *
 * The CLI is stood in for by a script on `CURSOR_AGENT_BIN` that replays a
 * fixture of `--output-format stream-json` lines, so this exercises the real
 * spawn, the real framing and the real teardown without the binary.
 */

const scratch = mkdtempSync(path.join(tmpdir(), "agent-ui-cursor-"))
const fixturePath = path.join(scratch, "fixture.jsonl")
const fakeAgent = path.join(scratch, "fake-agent")

writeFileSync(
  fakeAgent,
  `#!${process.execPath}\n` +
    `const fs = require("node:fs")\n` +
    `fs.writeSync(1, fs.readFileSync(process.env.AGENT_UI_TEST_FIXTURE, "utf8"))\n` +
    `const hold = Number(process.env.AGENT_UI_TEST_HOLD_MS || "0")\n` +
    `const code = Number(process.env.AGENT_UI_TEST_EXIT || "0")\n` +
    `if (hold > 0) setTimeout(() => process.exit(code), hold)\n` +
    `else process.exit(code)\n`,
  { mode: 0o755 }
)

const inheritedBin = process.env.CURSOR_AGENT_BIN
process.env.CURSOR_AGENT_BIN = fakeAgent
process.env.AGENT_UI_TEST_FIXTURE = fixturePath

after(() => {
  if (inheritedBin === undefined) delete process.env.CURSOR_AGENT_BIN
  else process.env.CURSOR_AGENT_BIN = inheritedBin
  delete process.env.AGENT_UI_TEST_FIXTURE
  delete process.env.AGENT_UI_TEST_HOLD_MS
  delete process.env.AGENT_UI_TEST_EXIT
  rmSync(scratch, { recursive: true, force: true })
})

function stage(
  lines: Record<string, unknown>[],
  options: { exit?: number; holdMs?: number } = {}
) {
  writeFileSync(
    fixturePath,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n"
  )
  process.env.AGENT_UI_TEST_EXIT = String(options.exit ?? 0)
  process.env.AGENT_UI_TEST_HOLD_MS = String(options.holdMs ?? 0)
}

function assistant(text: string, timestamp: number): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp_ms: timestamp,
    message: { content: [{ type: "text", text }] },
  }
}

const startedTool = {
  type: "tool_call",
  subtype: "started",
  call_id: "call-1",
  tool_call: { shellToolCall: { args: { command: "npm run dev" } } },
}

async function runToEnd(signal?: AbortSignal) {
  const { runCursorAgent } = await import("@/lib/cursor-agent")
  const events: AgentStreamEvent[] = []
  for await (const event of runCursorAgent({
    prompt: "hi",
    model: "auto",
    workspace: scratch,
    ...(signal ? { signal } : {}),
  })) {
    events.push(event)
  }
  return events
}

const CONNECT_ERROR =
  "Error: ConnectError: [unavailable] upstream connect error or disconnect"

test("a reply that is only a transport dump fails the turn", async () => {
  stage([
    assistant(`${CONNECT_ERROR}\n`, 1),
    assistant("    at TLSSocket.emit (node:events:519:28)\n", 2),
    { type: "result", session_id: "s1", duration_ms: 12, result: "" },
  ])

  const events = await runToEnd()
  assert.deepEqual(
    events.filter((event) => event.type === "text"),
    [],
    "the diagnostic is never stored as the answer"
  )
  assert.equal(
    events.some((event) => event.type === "done"),
    false,
    "and the turn is not remembered as a success"
  )
  const errors = events.filter((event) => event.type === "error")
  assert.equal(errors.length, 1)
  assert.equal(errors[0].type === "error" && errors[0].message, CONNECT_ERROR)
})

test("an answer that merely contains the diagnostic is still delivered", async () => {
  stage([
    assistant(`${CONNECT_ERROR}\nThat is what the retry loop prints.\n`, 1),
    { type: "result", session_id: "s1", duration_ms: 12, result: "" },
  ])

  const events = await runToEnd()
  const text = events
    .map((event) => (event.type === "text" ? event.text : ""))
    .join("")
  assert.ok(text.includes("That is what the retry loop prints."))
  assert.ok(text.includes(CONNECT_ERROR), "held text is released, not dropped")
  assert.equal(events.some((event) => event.type === "done"), true)
  assert.equal(events.some((event) => event.type === "error"), false)
})

test("ordinary text streams through untouched", async () => {
  stage([
    assistant("Looked at ", 1),
    assistant("two files.", 2),
    { type: "result", session_id: "s1", duration_ms: 5, result: "" },
  ])
  const events = await runToEnd()
  assert.deepEqual(
    events.filter((event) => event.type === "text"),
    [
      { type: "text", text: "Looked at " },
      { type: "text", text: "two files." },
    ]
  )
})

test("a tool the stream never closed is closed by the turn", async () => {
  stage([assistant("Starting the dev server.", 1), startedTool])

  const events = await runToEnd()
  const rows = events.filter((event) => event.type === "tool")
  assert.equal(rows.length, 2, "the started row, then its terminal one")
  assert.deepEqual(rows[1], {
    type: "tool",
    id: "call-1",
    name: "Shell",
    status: "error",
    output: "Interrupted",
  })
})

test("a non-zero exit closes the row and still reports the failure", async () => {
  stage([startedTool], { exit: 3 })

  const events = await runToEnd()
  assert.equal(
    events.some(
      (event) =>
        event.type === "tool" && event.status === "error" && event.id === "call-1"
    ),
    true
  )
  const error = events.find((event) => event.type === "error")
  assert.ok(error && error.type === "error" && /code 3/.test(error.message))
})

test("stopping the turn closes the rows it left open", async () => {
  stage([startedTool], { holdMs: 30_000 })

  const controller = new AbortController()
  const { runCursorAgent } = await import("@/lib/cursor-agent")
  const events: AgentStreamEvent[] = []
  for await (const event of runCursorAgent({
    prompt: "hi",
    model: "auto",
    workspace: scratch,
    signal: controller.signal,
  })) {
    events.push(event)
    if (event.type === "tool" && event.status === "running") controller.abort()
  }

  assert.deepEqual(events.at(-1), {
    type: "tool",
    id: "call-1",
    name: "Shell",
    status: "error",
    output: "Interrupted",
  })
})
