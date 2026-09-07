import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildArgs,
  ClaudeCodeTranslator,
  parseCliLine,
  permissionArgs,
  type ClaudeCodeCliEvent,
  type ClaudeTokenUsage,
} from "@/lib/claude-code-protocol"
import { estimateCost, priceForModel } from "@/lib/model-pricing"
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

test("a batched message keeps its one result to itself", () => {
  const translator = new ClaudeCodeTranslator()
  translator.translate(INIT)
  // Two parallel Bash calls answer in one user message, but `tool_use_result`
  // describes only one of them — so neither may claim it.
  const both = translator.translate({
    type: "user",
    message: {
      content: [
        { type: "tool_result", content: "boom", tool_use_id: "t5" },
        { type: "tool_result", content: "fine", tool_use_id: "t6" },
      ],
    },
    session_id: SESSION,
    tool_use_result: { stdout: "", stderr: "boom", exitCode: 2 },
  } as ClaudeCodeCliEvent)
  assert.deepEqual(both, [
    { type: "tool", id: "t5", name: "tool", status: "done", output: "boom" },
    { type: "tool", id: "t6", name: "tool", status: "done", output: "fine" },
  ])
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
      // the answer that the next turn's context has no relation to. They ride
      // beside it instead, where pricing can charge them their own rate.
      usage: {
        input: 2,
        output: 14,
        cachedInputTokens: 33133,
        cacheCreationTokens: 8478,
      },
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
    cacheRead: 0.2,
    cacheWrite: 2.5,
  })
  assert.deepEqual(priceForModel("sonnet", "claudeCode"), {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  })
  assert.deepEqual(priceForModel("opus", "claudeCode"), {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  })
  // An id no table knows stays unknown rather than reading as free.
  assert.equal(priceForModel("some-future-model", "claudeCode"), null)
  // Another harness's bare id is still priced by that harness, not here.
  assert.equal(priceForModel("claude-sonnet-5", "cursorAgent"), null)
})

/* -------------------------------------------------------------------------- */
/* Transient session ids                                                       */
/* -------------------------------------------------------------------------- */

/** SessionStart hooks on a resumed run, verbatim but for the dropped fields. */
const HOOK_SESSION = "7368d0c7-40a3-4d8a-bcc1-ac80c49f2719"

function hookLine(subtype: string): ClaudeCodeCliEvent {
  return {
    type: "system",
    subtype,
    session_id: HOOK_SESSION,
  } as ClaudeCodeCliEvent
}

test("a hook's transient session id never becomes the chat's", () => {
  const translator = new ClaudeCodeTranslator()
  // On `--resume` these three land *before* init, each carrying an id the
  // next turn's `--resume` would reject.
  for (const subtype of ["hook_started", "hook_progress", "hook_response"]) {
    assert.deepEqual(translator.translate(hookLine(subtype)), [])
  }
  assert.deepEqual(translator.translate(INIT), [
    { type: "session", sessionId: SESSION },
    READY,
  ])
})

test("any other line's session id is taken as it always was", () => {
  const translator = new ClaudeCodeTranslator()
  assert.deepEqual(
    translator.translate({
      type: "system",
      subtype: "active_goal",
      session_id: SESSION,
    } as ClaudeCodeCliEvent),
    [{ type: "session", sessionId: SESSION }]
  )
})

/* -------------------------------------------------------------------------- */
/* Subagents                                                                   */
/* -------------------------------------------------------------------------- */

const PARENT_TOOL = "toolu_01ParentTaskCall"
const SUB_MSG = "msg_01SubagentMessage"
const SUB_TOOL = "toolu_01SubagentBash"

function subagentStream(inner: Record<string, unknown>): ClaudeCodeCliEvent {
  return {
    type: "stream_event",
    event: inner,
    session_id: SESSION,
    parent_tool_use_id: PARENT_TOOL,
  } as ClaudeCodeCliEvent
}

test("a subagent's narration stays out of the parent's answer", () => {
  const events = body([
    subagentStream({ type: "message_start", message: { id: SUB_MSG } }),
    subagentStream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "I will grep for it." },
    }),
    subagentStream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Where is that file…" },
    }),
    // Its tool rows are work the user is watching, so those do come through.
    subagentStream({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: SUB_TOOL, name: "Bash" },
    }),
  ])
  assert.deepEqual(events, [
    { type: "tool", id: SUB_TOOL, name: "Bash", status: "running" },
  ])
})

test("a subagent's snapshot yields its tools and none of its text", () => {
  const events = body([
    {
      type: "assistant",
      parent_tool_use_id: PARENT_TOOL,
      message: {
        id: SUB_MSG,
        model: "claude-haiku-4-5",
        content: [
          { type: "text", text: "Found it in lib/store." },
          { type: "thinking", thinking: "Almost done." },
          { type: "tool_use", id: SUB_TOOL, name: "Grep", input: { q: "x" } },
        ],
      },
      session_id: SESSION,
    } as ClaudeCodeCliEvent,
  ])
  assert.deepEqual(events, [
    {
      type: "tool",
      id: SUB_TOOL,
      name: "Grep",
      status: "running",
      input: JSON.stringify({ q: "x" }, null, 2),
    },
  ])
})

test("a subagent's message id cannot suppress the parent's own text", () => {
  // The trap: a subagent's message_start arrives between the parent's, and a
  // shared id slot would file the parent's deltas under the subagent — after
  // which the parent's whole message prints its text a second time.
  const events = body([
    streamEvent({ type: "message_start", message: { id: MSG } }),
    subagentStream({ type: "message_start", message: { id: SUB_MSG } }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Done." },
    }),
    {
      type: "assistant",
      message: { id: MSG, content: [{ type: "text", text: "Done." }] },
      session_id: SESSION,
      parent_tool_use_id: null,
    } as ClaudeCodeCliEvent,
  ])
  assert.deepEqual(events, [{ type: "text", text: "Done." }])
})

test("the parent's model is noted and the subagent's is not", () => {
  const translator = new ClaudeCodeTranslator()
  translator.translate(INIT)
  translator.translate({
    type: "assistant",
    parent_tool_use_id: PARENT_TOOL,
    message: { id: SUB_MSG, model: "claude-haiku-4-5", content: [] },
    session_id: SESSION,
  } as ClaudeCodeCliEvent)
  assert.equal(translator.model, undefined)
  translator.translate({
    type: "assistant",
    message: { id: MSG, model: "claude-sonnet-5", content: [] },
    session_id: SESSION,
  } as ClaudeCodeCliEvent)
  assert.equal(translator.model, "claude-sonnet-5")
})

/* -------------------------------------------------------------------------- */
/* Finishing a turn that never got a result                                    */
/* -------------------------------------------------------------------------- */

function startedTool(translator: ClaudeCodeTranslator) {
  translator.translate(INIT)
  translator.translate(
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: TOOL, name: "Bash" },
    })
  )
}

test("an abandoned tool row is closed, not left spinning", () => {
  const translator = new ClaudeCodeTranslator()
  startedTool(translator)
  assert.deepEqual(translator.finish(false), [
    {
      type: "tool",
      id: TOOL,
      name: "Bash",
      status: "error",
      output: "Interrupted",
    },
  ])
  // Idempotent, and nothing translates after it.
  assert.deepEqual(translator.finish(false), [])
  assert.deepEqual(
    translator.translate({
      type: "assistant",
      message: { id: MSG, content: [{ type: "text", text: "late" }] },
      session_id: SESSION,
    } as ClaudeCodeCliEvent),
    []
  )
})

test("a tool the CLI never answered is done only when the turn succeeded", () => {
  const translator = new ClaudeCodeTranslator()
  startedTool(translator)
  const closed = translator.translate({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "All set.",
    session_id: SESSION,
  } as ClaudeCodeCliEvent)
  assert.deepEqual(closed[0], {
    type: "tool",
    id: TOOL,
    name: "Bash",
    status: "done",
  })
  // The result already closed it, so finishing after one adds nothing.
  assert.deepEqual(translator.finish(true), [])
})

test("a failed result closes its rows as errors", () => {
  const translator = new ClaudeCodeTranslator()
  startedTool(translator)
  const closed = translator.translate({
    type: "result",
    subtype: "success",
    is_error: true,
    terminal_reason: "budget_exhausted",
    session_id: SESSION,
  } as ClaudeCodeCliEvent)
  assert.deepEqual(closed[0], {
    type: "tool",
    id: TOOL,
    name: "Bash",
    status: "error",
    output: "Interrupted",
  })
})

test("finish(true) without a result is still not a success", () => {
  const translator = new ClaudeCodeTranslator()
  startedTool(translator)
  // Exit code 0, no result line: the CLI confirmed nothing about the tool.
  assert.deepEqual(translator.finish(true), [
    {
      type: "tool",
      id: TOOL,
      name: "Bash",
      status: "error",
      output: "Interrupted",
    },
  ])
})

/* -------------------------------------------------------------------------- */
/* What the result line actually says                                          */
/* -------------------------------------------------------------------------- */

function resultOf(
  fields: Partial<ClaudeCodeCliEvent>,
  before: ClaudeCodeCliEvent[] = []
): AgentStreamEvent[] {
  const translator = new ClaudeCodeTranslator()
  translator.translate(INIT)
  for (const event of before) translator.translate(event)
  return translator.translate({
    type: "result",
    session_id: SESSION,
    ...fields,
  } as ClaudeCodeCliEvent)
}

function errorOf(fields: Partial<ClaudeCodeCliEvent>): string | undefined {
  const event = resultOf(fields).find((one) => one.type === "error")
  return event?.type === "error" ? event.message : undefined
}

test("terminal_reason becomes a sentence the user can act on", () => {
  assert.equal(
    errorOf({ subtype: "success", is_error: true, terminal_reason: "prompt_too_long" }),
    "Claude stopped: the prompt exceeds the model's context window."
  )
  assert.equal(
    errorOf({ subtype: "success", is_error: true, terminal_reason: "budget_exhausted" }),
    "Claude stopped: the turn's token budget was exhausted."
  )
  assert.equal(
    errorOf({
      subtype: "success",
      is_error: true,
      terminal_reason: "malformed_tool_use_exhausted",
    }),
    "Claude gave up after repeated malformed tool calls."
  )
  assert.equal(
    errorOf({ subtype: "success", is_error: true, terminal_reason: "blocking_limit" }),
    "Claude stopped: a usage limit blocked the request."
  )
  assert.equal(
    errorOf({
      subtype: "success",
      is_error: true,
      terminal_reason: "rapid_refill_breaker",
    }),
    "Claude stopped: the context refilled too quickly after compaction."
  )
  assert.equal(
    errorOf({ subtype: "success", is_error: true, terminal_reason: "image_error" }),
    "Claude stopped: an image in the conversation could not be processed."
  )
  assert.equal(
    errorOf({ subtype: "success", is_error: true, terminal_reason: "turn_setup_failed" }),
    "Claude could not start the turn."
  )
})

test("a stop the user asked for is not an error row", () => {
  for (const terminal_reason of ["aborted_tools", "aborted_streaming"]) {
    const events = resultOf({
      subtype: "success",
      is_error: true,
      terminal_reason,
      errors: ["[ede_diagnostic] tool aborted"],
      duration_ms: 400,
    })
    assert.deepEqual(events, [
      { type: "done", sessionId: SESSION, durationMs: 400 },
    ])
  }
})

test("error_during_execution with no failure is a cancellation", () => {
  const events = resultOf({
    subtype: "error_during_execution",
    is_error: false,
    duration_ms: 12,
  })
  assert.deepEqual(events, [{ type: "done", sessionId: SESSION, durationMs: 12 }])
})

test("a 529 on a success result is the overload it really is", () => {
  assert.equal(
    errorOf({
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 529,
      errors: [],
    }),
    "Claude API is overloaded (529). Try again shortly."
  )
})

test("the CLI's own diagnostics never become the error text", () => {
  assert.equal(
    errorOf({
      subtype: "error_during_execution",
      is_error: true,
      errors: ["[ede_diagnostic] stream closed mid-tool", "Tool failed: EACCES"],
    }),
    "Tool failed: EACCES"
  )
  assert.equal(
    errorOf({
      subtype: "error_during_execution",
      is_error: true,
      errors: ["[ede_diagnostic] stream closed mid-tool"],
      result: "",
    }),
    "Claude Code failed"
  )
})

test("an earlier authentication failure explains a generic api_error", () => {
  const authLine = {
    type: "assistant",
    error: "authentication_failed",
    is_api_error_message: true,
    message: {
      id: MSG,
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "Not logged in. Please run /login" }],
    },
    session_id: SESSION,
  } as ClaudeCodeCliEvent

  const translator = new ClaudeCodeTranslator()
  translator.translate(INIT)
  translator.translate(authLine)
  const events = translator.translate({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "api_error",
    errors: [],
    session_id: SESSION,
  } as ClaudeCodeCliEvent)
  assert.match(
    events.find((one) => one.type === "error")?.type === "error"
      ? (events.find((one) => one.type === "error") as { message: string }).message
      : "",
    /could not authenticate/
  )

  // A *subagent's* failure is not the parent's, and must not be borrowed.
  const nested = resultOf(
    {
      subtype: "success",
      is_error: false,
      terminal_reason: "api_error",
      errors: [],
    },
    [{ ...authLine, parent_tool_use_id: PARENT_TOOL } as ClaudeCodeCliEvent]
  )
  assert.equal(
    nested.find((one) => one.type === "error")?.type === "error"
      ? (nested.find((one) => one.type === "error") as { message: string }).message
      : "",
    "Claude gave up after repeated API errors."
  )
})

test("an unknown model still fails with the CLI's own sentence", () => {
  assert.match(
    errorOf({
      subtype: "success",
      is_error: true,
      result: "There's an issue with the selected model (no-such-model-xyz).",
    }) ?? "",
    /no-such-model-xyz/
  )
})

/* -------------------------------------------------------------------------- */
/* Usage limits                                                                */
/* -------------------------------------------------------------------------- */

const NOW = Date.UTC(2026, 4, 1, 12)
/** The window reopens 2h 13m out; `resetsAt` is epoch **seconds**. */
const RESETS_AT = Math.floor(NOW / 1000) + 2 * 60 * 60 + 13 * 60

function limited(
  info: Record<string, unknown>,
  translator = new ClaudeCodeTranslator(() => NOW)
) {
  return {
    translator,
    events: translator.translate({
      type: "rate_limit_event",
      rate_limit_info: info,
      session_id: SESSION,
    } as ClaudeCodeCliEvent),
  }
}

test("a rejected window says how long the wait is and then ends the turn", () => {
  const translator = new ClaudeCodeTranslator(() => NOW)
  translator.translate(INIT)
  const { events } = limited(
    {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: RESETS_AT,
    },
    translator
  )
  assert.deepEqual(events, [
    {
      type: "status",
      text: "Rate limited on the 5-hour window, resets in 2h 13m",
    },
    {
      type: "error",
      message:
        "Claude usage limit reached. Rate limited on the 5-hour window, resets in 2h 13m. Send the message again once the window resets.",
    },
  ])
  // The CLI parks the turn and sends nothing more, so the caller has to stop
  // reading rather than wait for a result that will never come.
  assert.equal(translator.stopRequested, true)
  assert.deepEqual(translator.usageLimits?.windows, [
    {
      id: "five_hour",
      kind: "session",
      label: "5-hour",
      windowDurationMins: 300,
      usedPercent: 100,
      resetsAt: new Date(RESETS_AT * 1000).toISOString(),
    },
  ])
})

test("the same parked window is announced once per turn", () => {
  const translator = new ClaudeCodeTranslator(() => NOW)
  translator.translate(INIT)
  const info = {
    status: "rejected",
    rateLimitType: "five_hour",
    utilization: 1,
    resetsAt: RESETS_AT,
  }
  assert.equal(limited(info, translator).events.length, 2)
  // Siblings drift while a window is parked, so the identical line can arrive
  // again; deduping on the rendered text would let a shrinking wait through.
  assert.deepEqual(limited({ ...info, utilization: 0.99 }, translator).events, [])
  // A second window is its own wait, and does get said.
  assert.equal(
    limited(
      { ...info, rateLimitType: "seven_day", resetsAt: RESETS_AT + 3600 },
      translator
    ).events.length,
    2
  )
})

test("a window with headroom, or overage to spend, says nothing", () => {
  for (const info of [
    { status: "allowed", rateLimitType: "five_hour", utilization: 0.4 },
    { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.92 },
    // Rejected, but the account is allowed to spend overage: it keeps running.
    {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      overageStatus: "allowed",
    },
    {
      status: "rejected",
      rateLimitType: "seven_day",
      utilization: 1,
      isUsingOverage: true,
    },
  ]) {
    const translator = new ClaudeCodeTranslator(() => NOW)
    translator.translate(INIT)
    assert.deepEqual(limited(info, translator).events, [])
    assert.equal(translator.stopRequested, false)
  }
})

test("a window that parked the turn explains the result's generic api_error", () => {
  const translator = new ClaudeCodeTranslator(() => NOW)
  translator.translate(INIT)
  limited(
    { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: RESETS_AT },
    translator
  )
  const events = translator.translate({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "api_error",
    errors: [],
    session_id: SESSION,
  } as ClaudeCodeCliEvent)
  const error = events.find((one) => one.type === "error")
  assert.equal(
    error?.type === "error" ? error.message : "",
    "Claude usage limit reached. Send the message again once the limit resets."
  )
})

test("a recovered window stops explaining anything", () => {
  const translator = new ClaudeCodeTranslator(() => NOW)
  translator.translate(INIT)
  limited(
    { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: RESETS_AT },
    translator
  )
  limited(
    { status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: RESETS_AT },
    translator
  )
  const events = translator.translate({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "api_error",
    errors: [],
    session_id: SESSION,
  } as ClaudeCodeCliEvent)
  const error = events.find((one) => one.type === "error")
  assert.equal(
    error?.type === "error" ? error.message : "",
    "Claude gave up after repeated API errors."
  )
})

/* -------------------------------------------------------------------------- */
/* Token accounting                                                            */
/* -------------------------------------------------------------------------- */

test("the last iteration is the turn's usage, cache halves and all", () => {
  const events = resultOf({
    subtype: "success",
    is_error: false,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      iterations: [
        { input_tokens: 5, output_tokens: 6 },
        {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 33_133,
          cache_creation_input_tokens: 8_478,
          output_tokens_details: { thinking_tokens: 8 },
        },
      ],
    },
  })
  const done = events.find((one) => one.type === "done")
  assert.deepEqual(done?.type === "done" ? done.usage : null, {
    input: 10,
    output: 20,
    cachedInputTokens: 33_133,
    cacheCreationTokens: 8_478,
    reasoningTokens: 8,
  })
})

test("reasoning is a share of the output, never more than it", () => {
  const events = resultOf({
    subtype: "success",
    is_error: false,
    usage: {
      input_tokens: 2,
      output_tokens: 20,
      output_tokens_details: { thinking_tokens: 500 },
    },
  })
  const done = events.find((one) => one.type === "done")
  const usage: ClaudeTokenUsage | undefined =
    done?.type === "done" ? done.usage : undefined
  assert.equal(usage?.reasoningTokens, 20)
})

test("the true context window comes off modelUsage, largest first", () => {
  const translator = new ClaudeCodeTranslator()
  translator.translate(INIT)
  assert.equal(translator.contextWindow, undefined)
  translator.translate({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: SESSION,
    modelUsage: {
      "claude-haiku-4-5": { contextWindow: 200_000 },
      "claude-sonnet-5[1m]": { contextWindow: 1_000_000 },
    },
  } as ClaudeCodeCliEvent)
  assert.equal(translator.contextWindow, 1_000_000)
})

test("compaction is announced instead of silently halving the numbers", () => {
  const events = body([
    {
      type: "system",
      subtype: "compact_boundary",
      session_id: SESSION,
      compact_metadata: { pre_tokens: 180_000, post_tokens: 40_000 },
    } as ClaudeCodeCliEvent,
  ])
  assert.deepEqual(events, [
    { type: "status", text: "Context compacted: 180k → 40k tokens" },
  ])
})

/* -------------------------------------------------------------------------- */
/* Cache-aware pricing                                                         */
/* -------------------------------------------------------------------------- */

test("cache reads and writes are billed at their own rates", () => {
  // A million of each on Sonnet 5: $2 of input, $0.20 of cache read, $2.50 of
  // cache write — Anthropic's published tenth and quarter-more.
  const cost = estimateCost("claude-sonnet-5", 1_000_000, 0, "claudeCode", {
    cachedInputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
  })
  assert.ok(cost !== null && Math.abs(cost - 4.7) < 1e-9)

  // Absent cache counts price exactly as they always did.
  assert.equal(
    estimateCost("claude-sonnet-5", 1_000_000, 1_000_000, "claudeCode"),
    estimateCost("claude-sonnet-5", 1_000_000, 1_000_000, "claudeCode", {})
  )

  // A model with no price is still unknown, not free, cache tokens or not.
  assert.equal(
    estimateCost("some-future-model", 10, 10, "claudeCode", {
      cachedInputTokens: 10,
    }),
    null
  )
})

test("an init line carrying the account's windows records all of them", () => {
  const translator = new ClaudeCodeTranslator(() => NOW)
  translator.translate({
    type: "system",
    subtype: "init",
    session_id: SESSION,
    rate_limits_available: true,
    // The full read speaks in whole percentages and ISO reset times, unlike
    // the streamed notices' 0–1 fraction and epoch seconds.
    rate_limits: {
      five_hour: { utilization: 42, resets_at: "2026-05-01T14:00:00.000Z" },
      seven_day: { utilization: 10, resets_at: null },
      model_scoped: [
        { display_name: "Opus", utilization: 3, resets_at: null },
        { display_name: "no utilization", utilization: null, resets_at: null },
      ],
    },
  } as ClaudeCodeCliEvent)

  assert.deepEqual(translator.usageLimits?.windows, [
    {
      id: "five_hour",
      kind: "session",
      label: "5-hour",
      windowDurationMins: 300,
      usedPercent: 42,
      resetsAt: "2026-05-01T14:00:00.000Z",
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "7-day",
      windowDurationMins: 10080,
      usedPercent: 10,
    },
    {
      id: "seven_day_opus",
      kind: "weekly",
      label: "7-day Opus",
      windowDurationMins: 10080,
      usedPercent: 3,
    },
  ])
})
