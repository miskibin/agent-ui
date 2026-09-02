import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildArgs,
  ClaudeCodeTranslator,
  parseCliLine,
  permissionArgs,
  type ClaudeCodeCliEvent,
} from "@/lib/claude-code-protocol"
import { priceForModel } from "@/lib/model-pricing"
import type { AgentStreamEvent } from "@/lib/providers/types"

/**
 * Fixtures are trimmed from real output of
 * `claude -p --output-format stream-json --verbose --include-partial-messages`
 * (CLI 2.1.258): field names and nesting are verbatim, with only the noisy
 * startup lines and the fields nothing reads dropped.
 */

const SESSION = "ec340081-25eb-5119-8558-025be8fd22d6"
const MSG = "msg_011CeeUtBPwAV2sjbN1ogj8T"
const TOOL = "toolu_01S3NP9i6aQKHYBRKGoAChEp"

/** The real init also carries cwd, tools, model, permissionMode, plugins… */
const INIT = {
  type: "system",
  subtype: "init",
  session_id: SESSION,
} as ClaudeCodeCliEvent

const READY: AgentStreamEvent = {
  type: "status",
  stage: "connecting",
  text: "Claude Code session ready",
}

function streamEvent(inner: Record<string, unknown>): ClaudeCodeCliEvent {
  return {
    type: "stream_event",
    event: inner,
    session_id: SESSION,
    parent_tool_use_id: null,
  } as ClaudeCodeCliEvent
}

/** Everything after the session + init preamble every run opens with. */
function body(events: ClaudeCodeCliEvent[]): AgentStreamEvent[] {
  const translator = new ClaudeCodeTranslator()
  const all = [INIT, ...events].flatMap((event) => translator.translate(event))
  assert.deepEqual(all.slice(0, 2), [
    { type: "session", sessionId: SESSION },
    READY,
  ])
  return all.slice(2)
}

test("the first line carrying a session id emits exactly one session event", () => {
  const translator = new ClaudeCodeTranslator()
  // `active_goal` beats `init` to stdout and already carries the id.
  const first = translator.translate({
    type: "active_goal",
    session_id: SESSION,
  } as ClaudeCodeCliEvent)
  assert.deepEqual(first, [{ type: "session", sessionId: SESSION }])
  assert.deepEqual(translator.translate(INIT), [READY])
})

test("unknown startup and bookkeeping lines translate to nothing", () => {
  const translator = new ClaudeCodeTranslator()
  translator.translate(INIT)
  const noise = [
    { type: "autocompact_state", session_id: SESSION },
    { type: "rate_limit_event", session_id: SESSION },
    { type: "system", subtype: "commands_changed", session_id: SESSION },
    { type: "system", subtype: "status", status: "requesting", session_id: SESSION },
    { type: "system", subtype: "post_turn_summary", session_id: SESSION },
    { type: "system", subtype: "task_summary", session_id: SESSION },
  ] as ClaudeCodeCliEvent[]
  assert.deepEqual(
    noise.flatMap((event) => translator.translate(event)),
    []
  )
})

test("text arrives from the partial-message deltas, not twice", () => {
  const events = body([
    streamEvent({ type: "message_start", message: { id: MSG } }),
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hi! " },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Done." },
    }),
    // The same message then arrives whole; its text must not be replayed.
    {
      type: "assistant",
      message: { id: MSG, content: [{ type: "text", text: "Hi! Done." }] },
      session_id: SESSION,
    } as ClaudeCodeCliEvent,
  ])
  assert.deepEqual(events, [
    { type: "text", text: "Hi! " },
    { type: "text", text: "Done." },
  ])
})

test("a whole message still speaks when no deltas streamed it", () => {
  const events = body([
    {
      type: "assistant",
      message: { id: MSG, content: [{ type: "text", text: "No partials." }] },
      session_id: SESSION,
    } as ClaudeCodeCliEvent,
  ])
  assert.deepEqual(events, [{ type: "text", text: "No partials." }])
})

test("thinking deltas become thinking events", () => {
  const events = body([
    streamEvent({ type: "message_start", message: { id: MSG } }),
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Weighing it…" },
    }),
  ])
  assert.deepEqual(events, [{ type: "thinking", text: "Weighing it…" }])
})

test("a tool runs at content_block_start and gains its input when whole", () => {
  const events = body([
    streamEvent({ type: "message_start", message: { id: MSG } }),
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: TOOL, name: "Bash", input: {} },
    }),
    {
      type: "assistant",
      message: {
        id: MSG,
        content: [
          {
            type: "tool_use",
            id: TOOL,
            name: "Bash",
            input: { command: "wc -l note.txt" },
          },
        ],
      },
      session_id: SESSION,
    } as ClaudeCodeCliEvent,
  ])

  assert.deepEqual(events, [
    { type: "tool", id: TOOL, name: "Bash", status: "running" },
    {
      type: "tool",
      id: TOOL,
      name: "Bash",
      status: "running",
      input: JSON.stringify({ command: "wc -l note.txt" }, null, 2),
    },
  ])
})

test("a tool_result completes the row and prefers stdout over the model text", () => {
  const translator = new ClaudeCodeTranslator()
  translator.translate(INIT)
  translator.translate(
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: TOOL, name: "Bash", input: {} },
    })
  )
  const done = translator.translate({
    type: "user",
    message: {
      content: [
        {
          tool_use_id: TOOL,
          type: "tool_result",
          content: "2 note.txt",
          is_error: false,
        },
      ],
    },
    session_id: SESSION,
    tool_use_result: {
      stdout: "2 note.txt",
      stderr: "",
      interrupted: false,
      isImage: false,
    },
  } as ClaudeCodeCliEvent)

  // No exitCode: Bash reports its status as prose, never as a field, and an
  // invented 0 would be worse than none in a handoff.
  assert.deepEqual(done, [
    {
      type: "tool",
      id: TOOL,
      name: "Bash",
      status: "done",
      output: "2 note.txt",
    },
  ])
})

test("a missing is_error means success, and a true one means error", () => {
  const translator = new ClaudeCodeTranslator()
  translator.translate(INIT)

  // The Read tool's success payload carries no is_error field at all.
  const ok = translator.translate({
    type: "user",
    message: {
      content: [{ tool_use_id: "t1", type: "tool_result", content: "1\thello" }],
    },
    session_id: SESSION,
    tool_use_result: { type: "text", file: { filePath: "/w/note.txt" } },
  } as ClaudeCodeCliEvent)
  assert.equal(ok[0].type === "tool" && ok[0].status, "done")

  const failed = translator.translate({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          content: "Exit code 1\ncat: /nope: No such file or directory",
          is_error: true,
          tool_use_id: "t2",
        },
      ],
    },
    session_id: SESSION,
    tool_use_result: "Error: Exit code 1\ncat: /nope: No such file or directory",
  } as ClaudeCodeCliEvent)
  assert.deepEqual(failed, [
    {
      type: "tool",
      id: "t2",
      name: "tool",
      status: "error",
      output: "Exit code 1\ncat: /nope: No such file or directory",
    },
  ])
})

test("read-only reaches the model as a refusal it cannot route around", () => {
  const translator = new ClaudeCodeTranslator()
  translator.translate(INIT)
  const denied = translator.translate({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          content:
            "<tool_use_error>Error: No such tool available: Write. Write is disabled for this session, in subagents as well as here.</tool_use_error>",
          is_error: true,
          tool_use_id: "t3",
        },
      ],
    },
    session_id: SESSION,
  } as ClaudeCodeCliEvent)
  assert.equal(denied[0].type === "tool" && denied[0].status, "error")
})

test("an exit code is passed through only where one was published", () => {
  const translator = new ClaudeCodeTranslator()
  translator.translate(INIT)
  const withCode = translator.translate({
    type: "user",
    message: {
      content: [{ type: "tool_result", content: "boom", tool_use_id: "t4" }],
    },
    session_id: SESSION,
    tool_use_result: { stdout: "", stderr: "boom", exitCode: 2 },
  } as ClaudeCodeCliEvent)
  assert.equal(withCode[0].type === "tool" && withCode[0].exitCode, 2)
})

test("the result line yields token usage on done", () => {
  const events = body([
    streamEvent({ type: "message_start", message: { id: MSG } }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hi." },
    }),
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Hi.",
      session_id: SESSION,
      duration_ms: 2230,
      total_cost_usd: 0.0406826,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 8478,
        cache_read_input_tokens: 33133,
        output_tokens: 14,
      },
    } as ClaudeCodeCliEvent,
  ])

  assert.deepEqual(events, [
    { type: "text", text: "Hi." },
    {
      type: "done",
      sessionId: SESSION,
      durationMs: 2230,
      // Cache reads stay out of `input`: 33k of them would put a number under
      // the answer that the next turn's context has no relation to.
      usage: { input: 2, output: 14 },
    },
  ])
})

test("a result with no streamed text falls back to the result string", () => {
  const events = body([
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "The whole answer.",
      session_id: SESSION,
      duration_ms: 900,
    } as ClaudeCodeCliEvent,
  ])
  assert.deepEqual(events[0], { type: "text", text: "The whole answer." })
})

test("is_error fails a run even though subtype stays 'success'", () => {
  const events = body([
    {
      type: "result",
      subtype: "success",
      is_error: true,
      result:
        "There's an issue with the selected model (no-such-model-xyz). It may not exist or you may not have access to it.",
      session_id: SESSION,
      duration_ms: 120,
    } as ClaudeCodeCliEvent,
  ])
  assert.deepEqual(events, [
    {
      type: "error",
      message:
        "There's an issue with the selected model (no-such-model-xyz). It may not exist or you may not have access to it.",
    },
    { type: "done", sessionId: SESSION, durationMs: 120 },
  ])
})

test("sawResult marks a run the CLI actually finished", () => {
  const translator = new ClaudeCodeTranslator()
  translator.translate(INIT)
  assert.equal(translator.sawResult, false)
  translator.translate({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: SESSION,
  } as ClaudeCodeCliEvent)
  assert.equal(translator.sawResult, true)
})

test("parseCliLine skips the CLI's non-JSON chatter", () => {
  assert.equal(parseCliLine(""), null)
  assert.equal(parseCliLine("Warning: 1 MCP server skipped"), null)
  assert.equal(parseCliLine("{oops"), null)
  assert.deepEqual(parseCliLine('  {"type":"result"}\r'), { type: "result" })
})

test("read-only denies the writing tools outright", () => {
  assert.deepEqual(permissionArgs("read-only"), [
    "--permission-mode",
    "dontAsk",
    "--disallowedTools",
    "Edit,Write,NotebookEdit,Bash,BashOutput,KillShell",
  ])
})

test("edits accepts writes but approves no shell", () => {
  assert.deepEqual(permissionArgs("edits"), ["--permission-mode", "acceptEdits"])
})

test("full allows shell and network without bypassing permissions", () => {
  const args = permissionArgs("full")
  assert.deepEqual(args, [
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch",
  ])
  // bypassPermissions skips the CLI's own guardrails and refuses to start
  // under root — "full" must never reach for it.
  assert.ok(!args.includes("bypassPermissions"))
})

test("buildArgs asks for the streaming protocol and never carries the prompt", () => {
  const args = buildArgs({
    model: "claude-sonnet-5",
    effort: "high",
    sessionId: SESSION,
    permissionMode: "edits",
  })
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    "claude-sonnet-5",
    "--effort",
    "high",
    "--resume",
    SESSION,
    "--permission-mode",
    "acceptEdits",
  ])
})

test("buildArgs drops an effort the CLI does not know", () => {
  const args = buildArgs({ model: "sonnet", effort: "turbo", permissionMode: "edits" })
  assert.ok(!args.includes("--effort"))
  assert.ok(!args.includes("turbo"))
})

test("buildArgs omits --resume on a first turn", () => {
  const args = buildArgs({ model: "sonnet", permissionMode: "read-only" })
  assert.ok(!args.includes("--resume"))
})

test("the harness's bare ids are priced as Anthropic's own, aliases included", () => {
  assert.deepEqual(priceForModel("claude-sonnet-5", "claudeCode"), {
    input: 2,
    output: 10,
  })
  assert.deepEqual(priceForModel("sonnet", "claudeCode"), { input: 2, output: 10 })
  assert.deepEqual(priceForModel("opus", "claudeCode"), { input: 5, output: 25 })
  // An id no table knows stays unknown rather than reading as free.
  assert.equal(priceForModel("some-future-model", "claudeCode"), null)
  // Another harness's bare id is still priced by that harness, not here.
  assert.equal(priceForModel("claude-sonnet-5", "cursorAgent"), null)
})
