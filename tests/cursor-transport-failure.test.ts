import assert from "node:assert/strict"
import { test } from "node:test"

import { CursorTransportFailure } from "@/lib/cursor-transport-failure"

/**
 * The diagnostics below are the literal shapes the Cursor CLI prints in place
 * of an answer when its transport gives up. The rule under test is that only a
 * reply consisting of *nothing else* counts: an answer that quotes the same
 * text — and answers about retry handling do — must stay an answer.
 */

const CONNECT =
  "Error: ConnectError: [unavailable] upstream connect error or disconnect"
const RETRIABLE = "Error: RetriableError: stream reset before headers"
const SERVER =
  "Something went wrong communicating with the server. Please try again."

function replyOf(...chunks: string[]) {
  const reply = new CursorTransportFailure()
  for (const chunk of chunks) reply.push(chunk)
  return reply
}

test("each transport diagnostic is recognised on its own", () => {
  for (const line of [CONNECT, RETRIABLE, SERVER]) {
    assert.equal(replyOf(line).failure, line, line)
    assert.equal(replyOf(`${line}\n`).failure, line, `${line} (with newline)`)
  }
})

test("aborted and deadline_exceeded connect errors count too", () => {
  for (const code of ["aborted", "deadline_exceeded"]) {
    const line = `Error: ConnectError: [${code}] gave up`
    assert.equal(replyOf(line).failure, line)
  }
  // A code that is not one of the three is a message, not a transport failure.
  assert.equal(
    replyOf("Error: ConnectError: [invalid_argument] bad request").failure,
    undefined
  )
})

test("the indented stack under a diagnostic belongs to it", () => {
  const reply = replyOf(
    `${CONNECT}\n`,
    "    at Object.onData (/opt/cursor/agent.js:1:2)\n",
    "    at TLSSocket.emit (node:events:519:28)\n"
  )
  assert.equal(reply.failure, CONNECT)
})

test("one line of real output disqualifies the whole reply", () => {
  assert.equal(replyOf(`${CONNECT}\n`, "Here is the fix.\n").failure, undefined)
  // …and stays disqualified, however the diagnostic is repeated afterwards.
  assert.equal(
    replyOf(`${CONNECT}\n`, "Here is the fix.\n", `${SERVER}\n`).failure,
    undefined
  )
})

test("an answer that quotes the diagnostic is still an answer", () => {
  const reply = replyOf(
    "Retries are handled where you see\n",
    "```\n",
    `${RETRIABLE}\n`,
    "```\n"
  )
  assert.equal(reply.failure, undefined)
})

test("a chunk that splits a diagnostic mid-line is still read whole", () => {
  const reply = replyOf("Error: Conn", "ectError: [unavailable] gone")
  assert.equal(reply.failure, "Error: ConnectError: [unavailable] gone")
})

test("a line longer than the cap is prose, not a dump", () => {
  const reply = replyOf(`${CONNECT}\n`, "x".repeat(5000))
  assert.equal(reply.failure, undefined)
})

test("an empty or blank reply reports no failure", () => {
  assert.equal(new CursorTransportFailure().failure, undefined)
  assert.equal(replyOf("\n", "   \n").failure, undefined)
})

test("candidate goes false on the first chunk of an ordinary answer", () => {
  const reply = new CursorTransportFailure()
  assert.equal(reply.candidate, true)
  reply.push("Sure — here is what I found")
  assert.equal(reply.candidate, false, "no newline needed to disqualify")

  const dump = new CursorTransportFailure()
  dump.push(CONNECT)
  assert.equal(dump.candidate, true)
  assert.equal(dump.failure, CONNECT)
})
