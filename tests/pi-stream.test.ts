import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ABORT_COMMAND,
  buildPiArgs,
  CONFIRM_NO,
  CONFIRM_YES,
  dialogOutcome,
  dialogResponse,
  parsePiLine,
  PiTranslator,
  promptCommand,
  questionRow,
  STATE_COMMAND,
  toDialog,
  type PiDialog,
  type PiEvent,
} from "@/lib/pi-protocol"
import type { AgentStreamEvent } from "@/lib/providers/types"

/**
 * Fixtures are trimmed from real `pi --mode rpc` output (pi-coding-agent
 * 0.84.4) driving `deepseek/deepseek-v4-flash` through the generated ask-user
 * extension: field names and nesting are verbatim, with only the noisy deltas
 * and the fields nothing reads dropped.
 */

const SESSION = "01a07a68-8d31-75cb-ac5e-bf17272ec01b"
const CALL = "call_00_dnj8HZS4hgtiRAyRPD2yzO"
const DIALOG = "89bf95de-d46b-432f-9ccc-9264b20487db"

const STATE_RESPONSE: PiEvent = {
  id: "state",
  type: "response",
  command: "get_state",
  success: true,
  // The real response also carries model, thinkingLevel, sessionFile, counts…
  data: { sessionId: SESSION, isStreaming: false },
}

function run(events: PiEvent[]) {
  const translator = new PiTranslator()
  const out: AgentStreamEvent[] = []
  const dialogs: PiDialog[] = []
  let settled = false
  let runEnded = false
  for (const event of events) {
    const result = translator.translate(event)
    out.push(...result.events)
    if (result.dialog) dialogs.push(result.dialog)
    if (result.settled) settled = true
    if (result.runEnded) runEnded = true
  }
  return { events: out, dialogs, settled, runEnded, translator }
}

test("argv asks for an RPC session with exactly one extension", () => {
  assert.deepEqual(
    buildPiArgs({
      model: "deepseek/deepseek-v4-flash",
      sessionDir: "/data/pi/sessions",
      extensionPath: "/data/pi/extensions/ask-user.ts",
      sessionId: SESSION,
      thinking: "medium",
    }),
    [
      "--mode",
      "rpc",
      "--model",
      "deepseek/deepseek-v4-flash",
      "--session-dir",
      "/data/pi/sessions",
      // Discovery off, ours on: `-e` still loads past `--no-extensions`.
      "--no-extensions",
      "--no-themes",
      "--extension",
      "/data/pi/extensions/ask-user.ts",
      "--session-id",
      SESSION,
      "--thinking",
      "medium",
    ]
  )
})

test("a new session and a text-only turn leave their flags off", () => {
  const args = buildPiArgs({ model: "ollama/gemma3:4b", sessionDir: "/s" })
  assert.equal(args.includes("--session-id"), false)
  assert.equal(args.includes("--thinking"), false)
  assert.equal(args.includes("--extension"), false)
  // The prompt never rides in argv under RPC — it is a stdin command.
  assert.equal(args.includes("--"), false)
})

test("the prompt command carries images only when there are some", () => {
  assert.deepEqual(promptCommand("hi"), {
    id: "prompt",
    type: "prompt",
    message: "hi",
  })
  assert.deepEqual(
    promptCommand("what is this", [
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]),
    {
      id: "prompt",
      type: "prompt",
      message: "what is this",
      images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    }
  )
})

test("framing tolerates a trailing CR and skips anything that is not a record", () => {
  assert.deepEqual(parsePiLine('{"type":"agent_settled"}\r'), {
    type: "agent_settled",
  })
  assert.equal(parsePiLine(""), null)
  assert.equal(parsePiLine("  "), null)
  assert.equal(parsePiLine("Warning: something on stderr's twin"), null)
  assert.equal(parsePiLine('{"type":'), null)
})

test("the session id comes from the get_state response, once", () => {
  const { events } = run([STATE_RESPONSE, STATE_RESPONSE])
  assert.deepEqual(events, [{ type: "session", sessionId: SESSION }])
})

test("responses to other commands say nothing", () => {
  const { events } = run([
    { type: "response", command: "prompt", success: true },
    { type: "response", command: "get_state", success: true, data: {} },
  ])
  assert.deepEqual(events, [])
})

test("text and thinking deltas stream; the rest of message_update does not", () => {
  const { events } = run([
    { type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "weighing it" },
    },
    { type: "message_update", assistantMessageEvent: { type: "text_start" } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Blue it is." },
    },
    { type: "message_update", assistantMessageEvent: { type: "text_end" } },
  ])
  assert.deepEqual(events, [
    { type: "thinking", text: "weighing it" },
    { type: "text", text: "Blue it is." },
  ])
})

test("a tool call is announced at toolcall_start and filled in at execution", () => {
  const { events } = run([
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        id: CALL,
        toolName: "read",
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: CALL,
      toolName: "read",
      args: { path: "package.json" },
    },
    {
      type: "tool_execution_end",
      toolCallId: CALL,
      toolName: "read",
      result: { content: [{ type: "text", text: "{\n  \"name\": \"agent-ui\"" }] },
      isError: false,
    },
  ])
  assert.deepEqual(events, [
    { type: "tool", id: CALL, name: "read", status: "running" },
    {
      type: "tool",
      id: CALL,
      name: "read",
      status: "running",
      input: JSON.stringify({ path: "package.json" }, null, 2),
    },
    {
      type: "tool",
      id: CALL,
      name: "read",
      status: "done",
      output: '{\n  "name": "agent-ui"',
    },
  ])
})

test("an exit code is carried only when the tool published one", () => {
  const [row] = run([
    {
      type: "tool_execution_end",
      toolCallId: CALL,
      toolName: "run_tests",
      result: { content: [{ type: "text", text: "2 failing" }], exitCode: 1 },
      isError: true,
    },
  ]).events
  assert.deepEqual(row, {
    type: "tool",
    id: CALL,
    name: "run_tests",
    status: "error",
    output: "2 failing",
    exitCode: 1,
  })
  // pi's own bash is the other case: a non-zero exit becomes a thrown error
  // whose *text* names the code, and no field carries it. Reading the number
  // out of that prose would be a guess, and a fabricated `0` on the success
  // path would be worse — `status` already says the call succeeded.
  const [bash] = run([
    {
      type: "tool_execution_end",
      toolCallId: CALL,
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "boom\nCommand exited with code 2" }],
      },
      isError: true,
    },
  ]).events
  assert.equal("exitCode" in bash, false)
  const [plain] = run([
    {
      type: "tool_execution_end",
      toolCallId: CALL,
      toolName: "read",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    },
  ]).events
  assert.equal("exitCode" in plain, false)
})

test("an extension that throws surfaces as an error", () => {
  const { events } = run([
    {
      type: "extension_error",
      error: "ask-user.ts: Cannot find module 'typebox'",
    },
  ])
  assert.deepEqual(events, [
    { type: "error", message: "ask-user.ts: Cannot find module 'typebox'" },
  ])
})

test("usage is taken from the last message, and zeroes are not counts", () => {
  const { translator } = run([
    { type: "message_end", message: { role: "user" } },
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "toolUse", usage: { input: 3146, output: 101 } },
    },
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", usage: { input: 72, output: 32 } },
    },
    { type: "message_end", message: { role: "assistant", usage: { input: 0, output: 0 } } },
  ])
  assert.deepEqual(translator.lastUsage, { input: 72, output: 32 })
})

test("a failed model call is peeled down to the sentence inside it", () => {
  const { events, translator } = run([
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          '400: {"error":{"message":"registry.ollama.ai/library/gemma3:4b does not support tools"}}',
      },
    },
  ])
  // Held, not yielded: pi retries, and a recovered attempt must not read as a
  // failure. `runPiAgent` only uses it when the run produced no text.
  assert.deepEqual(events, [])
  assert.equal(
    translator.lastMessageError,
    "pi: 400 — registry.ollama.ai/library/gemma3:4b does not support tools"
  )
})

test("agent_settled ends the run; agent_end only arms the fallback", () => {
  assert.deepEqual(run([{ type: "agent_end", willRetry: false }]), {
    events: [],
    dialogs: [],
    settled: false,
    runEnded: true,
    translator: run([]).translator,
  })
  const retrying = run([{ type: "agent_end", willRetry: true }])
  assert.equal(retrying.runEnded, false)
  assert.equal(run([{ type: "agent_settled" }]).settled, true)
})

test("a select dialog becomes a select request whose ids are its labels", () => {
  const { dialogs, events } = run([
    {
      type: "tool_execution_start",
      toolCallId: CALL,
      toolName: "request_user_input",
      args: { question: "Which colour do you prefer?", options: ["Red", "Blue"] },
    },
    {
      type: "extension_ui_request",
      id: DIALOG,
      method: "select",
      title: "Which colour do you prefer?",
      options: ["Red", "Blue"],
      timeout: 30000,
    },
  ])
  assert.equal(events.length, 1) // the tool row; the dialog is not an event
  assert.deepEqual(dialogs, [
    {
      id: DIALOG,
      method: "select",
      timeout: 30000,
      request: {
        id: DIALOG,
        kind: "select",
        title: "Which colour do you prefer?",
        // pi answers a select with the option string, so the label is the id.
        options: [
          { id: "Red", label: "Red" },
          { id: "Blue", label: "Blue" },
        ],
        // Named so the UI can say which tool call is waiting.
        tool: {
          name: "request_user_input",
          input: { question: "Which colour do you prefer?", options: ["Red", "Blue"] },
        },
      },
    },
  ])
})

test("confirm becomes two options and input/editor become free text", () => {
  const confirm = toDialog({
    type: "extension_ui_request",
    id: DIALOG,
    method: "confirm",
    title: "Clear session?",
    message: "All messages will be lost.",
  })
  assert.deepEqual(confirm?.request, {
    id: DIALOG,
    kind: "confirm",
    title: "Clear session?",
    description: "All messages will be lost.",
    options: [
      { id: CONFIRM_YES, label: "Yes" },
      { id: CONFIRM_NO, label: "No" },
    ],
  })

  const input = toDialog({
    type: "extension_ui_request",
    id: DIALOG,
    method: "input",
    title: "Which port?",
    placeholder: "3000",
  })
  assert.deepEqual(input?.request, {
    id: DIALOG,
    kind: "input",
    title: "Which port?",
    placeholder: "3000",
  })

  // An editor has no placeholder; its prefill is the only hint on offer.
  const editor = toDialog({
    type: "extension_ui_request",
    id: DIALOG,
    method: "editor",
    title: "Edit the message",
    prefill: "chore: bump",
  })
  assert.equal(editor?.method, "editor")
  assert.equal(editor?.request.kind, "input")
  assert.equal(editor?.request.placeholder, "chore: bump")
})

test("fire-and-forget methods answer nothing; notify becomes a status", () => {
  const { events, dialogs } = run([
    {
      type: "extension_ui_request",
      id: "n1",
      method: "notify",
      message: "Command blocked by user",
      notifyType: "warning",
    },
    { type: "extension_ui_request", id: "n2", method: "setStatus", title: "x" },
    { type: "extension_ui_request", id: "n3", method: "setWidget" },
    { type: "extension_ui_request", id: "n4", method: "setTitle", title: "pi" },
    { type: "extension_ui_request", id: "n5", method: "set_editor_text" },
  ])
  assert.deepEqual(dialogs, [])
  assert.deepEqual(events, [
    { type: "status", stage: "loading", text: "Command blocked by user" },
  ])
})

test("a select with no options is not answerable and is dropped", () => {
  assert.equal(
    toDialog({ type: "extension_ui_request", id: DIALOG, method: "select", options: [] }),
    null
  )
  assert.equal(
    toDialog({ type: "extension_ui_request", method: "select", options: ["a"] }),
    null
  )
})

const SELECT: PiDialog = {
  id: DIALOG,
  method: "select",
  request: {
    id: DIALOG,
    kind: "select",
    title: "Which colour?",
    options: [
      { id: "Red", label: "Red" },
      { id: "Blue", label: "Blue" },
    ],
  },
}
const CONFIRM: PiDialog = {
  id: DIALOG,
  method: "confirm",
  request: { id: DIALOG, kind: "confirm", title: "Run it?" },
}
const INPUT: PiDialog = {
  id: DIALOG,
  method: "input",
  request: { id: DIALOG, kind: "input", title: "Which port?" },
}

test("an answer is written back in the shape its own method expects", () => {
  assert.deepEqual(dialogResponse(SELECT, { optionId: "Blue" }), {
    type: "extension_ui_response",
    id: DIALOG,
    value: "Blue",
  })
  // Someone typing past the options still answers a select — it is a string
  // either way, and the extension never sees the difference.
  assert.deepEqual(dialogResponse(SELECT, { text: "Green" }), {
    type: "extension_ui_response",
    id: DIALOG,
    value: "Green",
  })
  assert.deepEqual(dialogResponse(CONFIRM, { optionId: CONFIRM_YES }), {
    type: "extension_ui_response",
    id: DIALOG,
    confirmed: true,
  })
  assert.deepEqual(dialogResponse(CONFIRM, { optionId: CONFIRM_NO }), {
    type: "extension_ui_response",
    id: DIALOG,
    confirmed: false,
  })
  assert.deepEqual(dialogResponse(INPUT, { text: "8080" }), {
    type: "extension_ui_response",
    id: DIALOG,
    value: "8080",
  })
})

test("every way of not answering cancels the dialog rather than hanging it", () => {
  for (const dialog of [SELECT, CONFIRM, INPUT]) {
    assert.deepEqual(dialogResponse(dialog, { cancelled: true }), {
      type: "extension_ui_response",
      id: DIALOG,
      cancelled: true,
    })
    assert.deepEqual(dialogResponse(dialog, null), {
      type: "extension_ui_response",
      id: DIALOG,
      cancelled: true,
    })
    assert.deepEqual(dialogResponse(dialog, {}), {
      type: "extension_ui_response",
      id: DIALOG,
      cancelled: true,
    })
  }
})

test("the question row opens on the request and closes on the outcome", () => {
  const opened = questionRow(SELECT)
  assert.deepEqual(opened, {
    type: "tool",
    id: `question:${DIALOG}`,
    name: "question",
    status: "running",
    input: JSON.stringify(SELECT.request, null, 2),
  })

  const answered = questionRow(SELECT, dialogOutcome(SELECT, { optionId: "Blue" }))
  assert.equal(answered.type === "tool" && answered.status, "done")
  assert.equal(answered.type === "tool" && answered.output, "Selected: Blue")
  // Same id both times, so the row is updated rather than duplicated.
  assert.equal(answered.type === "tool" && answered.id, `question:${DIALOG}`)
})

test("each outcome says what actually happened", () => {
  assert.deepEqual(dialogOutcome(CONFIRM, { optionId: CONFIRM_YES }), {
    status: "done",
    output: "Confirmed.",
  })
  assert.deepEqual(dialogOutcome(CONFIRM, { optionId: CONFIRM_NO }), {
    status: "done",
    output: "Declined.",
  })
  assert.deepEqual(dialogOutcome(INPUT, { text: "8080" }), {
    status: "done",
    output: "Answered: 8080",
  })
  assert.deepEqual(dialogOutcome(SELECT, { cancelled: true }), {
    status: "done",
    output: "Cancelled by the user.",
  })
  // A run with no `askUser` is not a user decision — it is a missing channel,
  // and the row has to say so rather than read as someone declining.
  assert.equal(dialogOutcome(SELECT, null, "no-channel").status, "error")
  assert.equal(dialogOutcome(SELECT, null, "timeout").status, "error")
  assert.equal(dialogOutcome(SELECT, null, "gone").status, "error")
})

test("the commands that bracket a run are fixed records", () => {
  assert.deepEqual(STATE_COMMAND, { id: "state", type: "get_state" })
  assert.deepEqual(ABORT_COMMAND, { type: "abort" })
})

/**
 * The whole shape of the turn the live run produced, driven through the
 * translator the way `runPiAgent` drives it — including the stdin the dialog
 * gets answered with, which is the half json mode could never send.
 */
test("a full ask-and-continue turn translates end to end", () => {
  const stdin: unknown[] = []
  const stdout: AgentStreamEvent[] = []
  const translator = new PiTranslator()
  const lines = [
    JSON.stringify(STATE_RESPONSE),
    '{"type":"response","command":"prompt","success":true}',
    '{"type":"agent_start"}',
    '{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","id":"' +
      CALL +
      '","toolName":"request_user_input"}}',
    '{"type":"tool_execution_start","toolCallId":"' +
      CALL +
      '","toolName":"request_user_input","args":{"question":"Which colour do you prefer?","options":["Red","Blue"]}}',
    '{"type":"extension_ui_request","id":"' +
      DIALOG +
      '","method":"select","title":"Which colour do you prefer?","options":["Red","Blue"]}',
    '{"type":"tool_execution_end","toolCallId":"' +
      CALL +
      '","toolName":"request_user_input","result":{"content":[{"type":"text","text":"The user answered: Blue"}]},"isError":false}',
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Blue it is."}}',
    '{"type":"agent_end","willRetry":false}',
    '{"type":"agent_settled"}\r',
  ]

  let settled = false
  for (const line of lines) {
    const event = parsePiLine(line)
    assert.notEqual(event, null)
    const result = translator.translate(event!)
    stdout.push(...result.events)
    if (result.dialog) {
      stdout.push(questionRow(result.dialog))
      const answer = { optionId: "Blue" }
      stdin.push(dialogResponse(result.dialog, answer))
      stdout.push(questionRow(result.dialog, dialogOutcome(result.dialog, answer)))
    }
    if (result.settled) settled = true
  }

  assert.equal(settled, true)
  assert.deepEqual(stdin, [
    { type: "extension_ui_response", id: DIALOG, value: "Blue" },
  ])
  assert.deepEqual(
    stdout.map((event) =>
      event.type === "tool" ? `${event.name}:${event.status}` : event.type
    ),
    [
      "session",
      "request_user_input:running",
      "request_user_input:running",
      "question:running",
      "question:done",
      "request_user_input:done",
      "text",
    ]
  )
})
