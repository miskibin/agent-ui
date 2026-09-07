import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

/**
 * Reading Codex's own history out of `~/.codex/sessions`.
 *
 * Two things make this format different from Claude's, and both are what the
 * tests below are about: the conversation is a log of *events* rather than of
 * messages, so the same prompt can appear twice in it; and nothing in this app
 * runs Codex, so what comes back is history — no resumable session id is ever
 * written beside it.
 */

const CODEX_HOME = mkdtempSync(join(tmpdir(), "agent-ui-codex-home-"))
process.env.CODEX_HOME = CODEX_HOME

const {
  codexProjects,
  codexSessionsDir,
  parseCodexTranscript,
  scanCodexTranscripts,
  sessionIdFromName,
} = await import("@/lib/import/codex-history")

const ROLLOUT = "5b8f2e14-3c9a-4d21-b8e6-0a1b2c3d4e5f"

function writeRollout(
  parts: [string, string, string],
  name: string,
  lines: unknown[],
  mtimeMs = Date.now()
) {
  const directory = join(codexSessionsDir(), ...parts)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${name}.jsonl`)
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
  const seconds = mtimeMs / 1000
  utimesSync(path, seconds, seconds)
  return path
}

test("a rollout's session id is the tail of its file name", () => {
  assert.equal(
    sessionIdFromName(`rollout-2026-01-05T10-00-00-${ROLLOUT}`),
    ROLLOUT
  )
  assert.equal(sessionIdFromName("rollout-2026-01-05T10-00-00-nope"), "")
})

test("the date-partitioned tree is walked and grouped by folder", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-ui-codex-workspace-"))
  writeRollout(
    ["2026", "01", "05"],
    `rollout-2026-01-05T10-00-00-${ROLLOUT}`,
    [
      { type: "session_meta", payload: { id: ROLLOUT, cwd: workspace } },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "add a test" },
      },
    ],
    Date.parse("2026-01-05T10:00:00.000Z")
  )
  // Not a rollout, and not a `.jsonl` — neither may be picked up.
  writeRollout(["2026", "01", "05"], "history", [{ type: "noise" }])

  const scan = await scanCodexTranscripts()
  assert.deepEqual([...scan.byCwd.keys()], [workspace])
  assert.equal(scan.byCwd.get(workspace)?.length, 1)

  const projects = codexProjects(scan)
  assert.deepEqual(projects, [
    {
      cwd: workspace,
      provider: "codex",
      conversations: 1,
      lastActiveAt: Date.parse("2026-01-05T10:00:00.000Z"),
      resumable: false,
    },
  ])
})

test("a prompt logged as both an event and a response item is one message", () => {
  const conversation = parseCodexTranscript(
    [
      { type: "session_meta", payload: { id: ROLLOUT, cwd: "/repo" } },
      { type: "turn_context", payload: { model: "gpt-5-codex" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "rename the folder" }],
        },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "rename the folder" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Renamed." }],
        },
      },
      // The same words again, a turn later: two prompts, not one.
      {
        type: "event_msg",
        payload: { type: "user_message", message: "rename the folder" },
      },
    ],
    { sourcePath: "/x.jsonl", fallbackSessionId: "", mtimeMs: 1 }
  )
  assert.ok(conversation)
  assert.deepEqual(
    conversation.messages.map((message) => `${message.role}:${message.text}`),
    [
      "user:rename the folder",
      "assistant:Renamed.",
      "user:rename the folder",
    ]
  )
  assert.equal(conversation.model, "gpt-5-codex")
  assert.equal(conversation.title, "rename the folder")
})

test("the event copy wins whichever order the two arrive in", () => {
  const conversation = parseCodexTranscript(
    [
      { type: "session_meta", payload: { id: ROLLOUT, cwd: "/repo" } },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "ship it" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "ship it" }],
        },
      },
    ],
    { sourcePath: "/x.jsonl", fallbackSessionId: "", mtimeMs: 1 }
  )
  assert.ok(conversation)
  assert.deepEqual(
    conversation.messages.map((message) => message.text),
    ["ship it"]
  )
})

test("reasoning, tool calls and their output are not conversation", () => {
  const conversation = parseCodexTranscript(
    [
      { type: "session_meta", payload: { id: ROLLOUT, cwd: "/repo" } },
      { type: "event_msg", payload: { type: "user_message", message: "run the tests" } },
      { type: "response_item", payload: { type: "reasoning", summary: [] } },
      {
        type: "response_item",
        payload: { type: "function_call", name: "shell", arguments: "{}" },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", output: "12 passing" },
      },
      { type: "event_msg", payload: { type: "agent_reasoning", text: "thinking" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "All 12 pass." }],
        },
      },
    ],
    { sourcePath: "/x.jsonl", fallbackSessionId: "", mtimeMs: 1 }
  )
  assert.ok(conversation)
  assert.deepEqual(
    conversation.messages.map((message) => `${message.role}:${message.text}`),
    ["user:run the tests", "assistant:All 12 pass."]
  )
})

test("the rollout's own id is read from session_meta, and the file name backs it up", () => {
  const fromMeta = parseCodexTranscript(
    [
      { type: "session_meta", payload: { session_id: ROLLOUT, cwd: "/repo" } },
      { type: "event_msg", payload: { type: "user_message", message: "hi" } },
    ],
    { sourcePath: "/x.jsonl", fallbackSessionId: "", mtimeMs: 1 }
  )
  assert.equal(fromMeta?.sessionId, ROLLOUT)

  const fromName = parseCodexTranscript(
    [
      { type: "session_meta", payload: { cwd: "/repo" } },
      { type: "event_msg", payload: { type: "user_message", message: "hi" } },
    ],
    { sourcePath: "/x.jsonl", fallbackSessionId: ROLLOUT, mtimeMs: 1 }
  )
  assert.equal(fromName?.sessionId, ROLLOUT)
})

test("a rollout that never names its folder is not importable", () => {
  assert.equal(
    parseCodexTranscript(
      [{ type: "event_msg", payload: { type: "user_message", message: "hi" } }],
      { sourcePath: "/x.jsonl", fallbackSessionId: ROLLOUT, mtimeMs: 1 }
    ),
    null
  )
})
