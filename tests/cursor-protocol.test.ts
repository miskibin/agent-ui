import assert from "node:assert/strict"
import { test } from "node:test"

import { compareVersions, versionParts } from "@/lib/agent-runtime"
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
