import assert from "node:assert/strict"
import { test } from "node:test"

import {
  boundToolOutput,
  cancellationReply,
  decideToolCallUpdateEmission,
  mapAcpUpdate,
  rawOutputTextChars,
  sessionUpdateIsReplay,
  toolCallProgressLength,
  type AcpToolCallState,
} from "@/lib/acp-protocol"

/**
 * The behaviours here all exist because an ACP agent is allowed to be chatty:
 * some resend the entire accumulated tool output on every `tool_call_update`,
 * several times a second, and a redrawing terminal then costs one stream event
 * — and one stored transcript's worth of text — per redraw.
 */

const MAX = 8_000
const MARKER = "[Earlier output truncated]"

function update(fields: Record<string, unknown>) {
  return { update: { sessionUpdate: "tool_call_update", ...fields } }
}

function textContent(text: string) {
  return [{ type: "content", content: { type: "text", text } }]
}

test("tool output is bounded to a tail, not a head", () => {
  const short = "line\n".repeat(10)
  assert.equal(boundToolOutput(short), short)

  const long = `${"a".repeat(MAX)}TAIL-MARKER`
  const bounded = boundToolOutput(long)
  assert.ok(bounded.startsWith(MARKER), "says what it dropped")
  assert.ok(bounded.endsWith("TAIL-MARKER"), "keeps the end, which is the news")
  assert.equal(bounded.length, MARKER.length + 2 + MAX)
})

test("rawOutput's known text fields are measured, and each one capped", () => {
  assert.equal(rawOutputTextChars(undefined), 0)
  assert.equal(rawOutputTextChars("plain string"), 0)
  assert.equal(
    rawOutputTextChars({ stdout: "abc", stderr: "de", ignored: "xxxxx" }),
    5
  )
  // A single megabyte-sized field cannot make the progress number unbounded.
  assert.equal(rawOutputTextChars({ output: "x".repeat(5_000_000) }), MAX)
})

test("progress is the longest of the three things that grow", () => {
  const state: AcpToolCallState = {
    toolCallId: "t1",
    input: "12345",
    output: "1234567",
    rawOutputChars: 3,
  }
  assert.equal(toolCallProgressLength(state), 7)
  assert.equal(toolCallProgressLength({ toolCallId: "t1" }), 0)
})

test("a completed or failed update is never held back", () => {
  for (const status of ["done", "error"] as const) {
    const decision = decideToolCallUpdateEmission({
      previous: { toolCallId: "t1", status: "running", output: "x" },
      next: { toolCallId: "t1", status, output: "x" },
      lastEmittedProgress: 1,
      skippedSinceEmit: 4,
    })
    assert.deepEqual(decision, { emit: true, skippedSinceEmit: 0 })
  }
})

test("a first sighting, a new title and a new status always emit", () => {
  const next: AcpToolCallState = {
    toolCallId: "t1",
    title: "bash",
    status: "running",
  }
  assert.equal(
    decideToolCallUpdateEmission({
      previous: undefined,
      next,
      lastEmittedProgress: undefined,
      skippedSinceEmit: 0,
    }).emit,
    true
  )
  assert.equal(
    decideToolCallUpdateEmission({
      previous: { toolCallId: "t1", title: "sh", status: "running" },
      next,
      lastEmittedProgress: 0,
      skippedSinceEmit: 0,
    }).emit,
    true
  )
})

test("an update that changed nothing is dropped without counting", () => {
  const state: AcpToolCallState = {
    toolCallId: "t1",
    title: "bash",
    status: "running",
    input: "{}",
    output: "same",
    rawOutputChars: 4,
  }
  const decision = decideToolCallUpdateEmission({
    previous: state,
    next: { ...state },
    lastEmittedProgress: 4,
    skippedSinceEmit: 3,
  })
  // Unchanged is not "progress the UI is waiting on", so the skip counter that
  // forces a periodic emission must not advance either.
  assert.deepEqual(decision, { emit: false, skippedSinceEmit: 3 })
})

test("a redrawing terminal is coalesced until it grows or ten pass", () => {
  const base: AcpToolCallState = {
    toolCallId: "t1",
    title: "bash",
    status: "running",
    output: "",
  }
  let skipped = 0
  let emitted = 0
  let lastEmittedProgress: number | undefined = 0
  let previous = base
  // Ten updates that each shift a bounded tail by a few characters.
  for (let index = 0; index < 10; index++) {
    const next = { ...base, output: `${index}`.repeat(8) }
    const decision = decideToolCallUpdateEmission({
      previous,
      next,
      lastEmittedProgress,
      skippedSinceEmit: skipped,
    })
    skipped = decision.skippedSinceEmit
    if (decision.emit) {
      emitted += 1
      lastEmittedProgress = toolCallProgressLength(next)
    }
    previous = next
  }
  assert.equal(emitted, 1, "one periodic emission, not ten redraws")
  assert.equal(skipped, 0, "and the counter restarts after it")

  // A real paragraph of new output is not made to wait for the tenth update.
  assert.equal(
    decideToolCallUpdateEmission({
      previous,
      next: { ...base, output: "x".repeat(400) },
      lastEmittedProgress: 8,
      skippedSinceEmit: 0,
    }).emit,
    true
  )
})

test("mapAcpUpdate carries the creation's title onto later patches", () => {
  const tools = new Map<string, AcpToolCallState>()
  const created = mapAcpUpdate(
    {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "bash",
        status: "pending",
      },
    },
    tools
  )
  assert.equal(created.length, 1)
  assert.deepEqual(created[0], {
    type: "tool",
    id: "t1",
    name: "bash",
    status: "running",
  })

  const done = mapAcpUpdate(
    update({ toolCallId: "t1", status: "completed", content: textContent("ok") }),
    tools
  )
  assert.deepEqual(done[0], {
    type: "tool",
    id: "t1",
    name: "bash",
    status: "done",
    output: "ok",
  })
})

test("mapAcpUpdate bounds a resent terminal buffer and coalesces the redraws", () => {
  const tools = new Map<string, AcpToolCallState>()
  mapAcpUpdate(
    {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "bash",
        status: "in_progress",
      },
    },
    tools
  )

  let emitted = 0
  let last: string | undefined
  for (let index = 0; index < 12; index++) {
    // The whole accumulated output, resent, growing by one character.
    const whole = `${"z".repeat(MAX * 2)}${"!".repeat(index + 1)}`
    const events = mapAcpUpdate(
      update({ toolCallId: "t1", status: "in_progress", content: textContent(whole) }),
      tools
    )
    for (const event of events) {
      emitted += 1
      if (event.type === "tool") last = event.output
    }
  }
  assert.ok(emitted < 12, `coalesced (${emitted} of 12 emitted)`)
  assert.ok(last && last.startsWith(MARKER), "and what is emitted is bounded")
  assert.ok(last!.length < MAX * 2, "nowhere near the resent buffer's size")
})

test("a per-notification replay marker is recognised", () => {
  assert.equal(sessionUpdateIsReplay({ _meta: { isReplay: true } }), true)
  assert.equal(sessionUpdateIsReplay({ _meta: { isReplay: false } }), false)
  assert.equal(sessionUpdateIsReplay({ _meta: { isReplay: "true" } }), false)
  assert.equal(sessionUpdateIsReplay({ _meta: {} }), false)
  assert.equal(sessionUpdateIsReplay({}), false)
  assert.equal(sessionUpdateIsReplay(null), false)
})

test("a stopped run answers a permission with cancelled and an fs call with an error", () => {
  assert.deepEqual(cancellationReply("session/request_permission"), {
    result: { outcome: { outcome: "cancelled" } },
  })
  assert.deepEqual(cancellationReply("session/request_user_input"), {
    result: { outcome: { outcome: "cancelled" } },
  })
  const refused = cancellationReply("fs/read_text_file")
  assert.ok("error" in refused && refused.error.code === -32603)
})
