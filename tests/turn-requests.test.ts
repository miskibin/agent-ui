import test from "node:test"
import assert from "node:assert/strict"

import {
  answerUserRequest,
  createAskUser,
  formatUserRequestInput,
  isOpenUserRequestTool,
  listUserRequests,
  parseUserRequestInput,
  sanitizeUserRequestAnswer,
  userRequestToolName,
  type UserRequest,
} from "@/lib/turn-requests"

const permission = (id: string): UserRequest => ({
  id,
  kind: "permission",
  title: "Allow write_file?",
  description: '{"path":"hello.txt"}',
  options: [
    { id: "allow", label: "Allow once", kind: "allow_once" },
    { id: "deny", label: "Reject", kind: "reject_once" },
  ],
  tool: { name: "write_file", input: { path: "hello.txt" } },
})

test("a registered request is resolved by its answer", async () => {
  const ask = createAskUser({ sessionId: "chat-1" })
  const waiting = ask(permission("req-1"))

  assert.equal(listUserRequests("chat-1").length, 1)
  assert.equal(listUserRequests("chat-1")[0].request.title, "Allow write_file?")

  assert.equal(answerUserRequest("chat-1", "req-1", { optionId: "allow" }), true)
  assert.deepEqual(await waiting, { optionId: "allow" })
  // The entry is gone, so the same answer cannot land twice.
  assert.equal(answerUserRequest("chat-1", "req-1", { optionId: "allow" }), false)
  assert.equal(listUserRequests("chat-1").length, 0)
})

test("an unknown session or request id answers nothing", async () => {
  const ask = createAskUser({ sessionId: "chat-2" })
  const waiting = ask(permission("req-2"))

  assert.equal(answerUserRequest("chat-2", "nope", { optionId: "allow" }), false)
  // Right request, wrong chat: the key is both, so this must not cross over.
  assert.equal(answerUserRequest("other", "req-2", { optionId: "allow" }), false)

  answerUserRequest("chat-2", "req-2", { cancelled: true })
  assert.deepEqual(await waiting, { cancelled: true })
})

test("aborting the turn cancels every request parked on it", async () => {
  const controller = new AbortController()
  const ask = createAskUser({ sessionId: "chat-3", signal: controller.signal })
  const waiting = ask(permission("req-3"))
  assert.equal(listUserRequests("chat-3").length, 1)

  controller.abort()
  assert.deepEqual(await waiting, { cancelled: true })
  assert.equal(listUserRequests("chat-3").length, 0)

  // A run that is already gone never registers at all.
  assert.deepEqual(await ask(permission("req-4")), { cancelled: true })
  assert.equal(listUserRequests("chat-3").length, 0)
})

test("reusing an id releases the request it displaces", async () => {
  const ask = createAskUser({ sessionId: "chat-4" })
  const first = ask(permission("dup"))
  const second = ask(permission("dup"))

  assert.deepEqual(await first, { cancelled: true })
  assert.equal(listUserRequests("chat-4").length, 1)
  answerUserRequest("chat-4", "dup", { optionId: "deny" })
  assert.deepEqual(await second, { optionId: "deny" })
})

test("a request round-trips through the tool event's input", () => {
  const request = permission("req-5")
  const parsed = parseUserRequestInput(formatUserRequestInput(request))
  assert.deepEqual(parsed, request)
})

test("only a well-formed request parses out of a tool input", () => {
  assert.equal(parseUserRequestInput(undefined), null)
  assert.equal(parseUserRequestInput(""), null)
  assert.equal(parseUserRequestInput("{ not json"), null)
  assert.equal(parseUserRequestInput('{"path":"a.ts"}'), null)
  // A tool whose arguments happen to be JSON is not a request.
  assert.equal(
    parseUserRequestInput('{"requestId":"r","title":"t"}'),
    null,
    "no kind"
  )
  assert.equal(
    parseUserRequestInput('{"requestId":"r","kind":"wat","title":"t"}'),
    null,
    "unknown kind"
  )
  const minimal = parseUserRequestInput(
    '{"requestId":"r","kind":"input","title":"Which branch?"}'
  )
  assert.deepEqual(minimal, { id: "r", kind: "input", title: "Which branch?" })
  // Options without an id or a label are dropped rather than rendered blank.
  const partial = parseUserRequestInput(
    '{"requestId":"r","kind":"select","title":"t","options":[{"id":"a"},{"id":"b","label":"B"}]}'
  )
  assert.deepEqual(partial?.options, [{ id: "b", label: "B" }])
})

test("an open request tool is a waiting row and nothing else", () => {
  const input = formatUserRequestInput(permission("req-6"))
  assert.equal(isOpenUserRequestTool({ name: "permission", status: "running", input }), true)
  assert.equal(isOpenUserRequestTool({ name: "question", status: "pending", input }), true)
  assert.equal(isOpenUserRequestTool({ name: "permission", status: "done", input }), false)
  assert.equal(isOpenUserRequestTool({ name: "permission", status: "error", input }), false)
  // A tool that is not one of the two names, however its input looks.
  assert.equal(isOpenUserRequestTool({ name: "write_file", status: "running", input }), false)
  // The right name with an input the form could not render.
  assert.equal(
    isOpenUserRequestTool({ name: "permission", status: "running", input: '{"a":1}' }),
    false
  )
})

test("the tool name follows the request kind", () => {
  assert.equal(userRequestToolName("permission"), "permission")
  assert.equal(userRequestToolName("select"), "question")
  assert.equal(userRequestToolName("confirm"), "question")
  assert.equal(userRequestToolName("input"), "question")
})

test("an answer off the wire must actually say something", () => {
  assert.equal(sanitizeUserRequestAnswer(null), null)
  assert.equal(sanitizeUserRequestAnswer({}), null)
  assert.equal(sanitizeUserRequestAnswer({ optionId: 7 }), null)
  assert.deepEqual(sanitizeUserRequestAnswer({ optionId: "allow" }), { optionId: "allow" })
  assert.deepEqual(sanitizeUserRequestAnswer({ text: "" }), { text: "" })
  assert.deepEqual(sanitizeUserRequestAnswer({ cancelled: true }), { cancelled: true })
  assert.deepEqual(sanitizeUserRequestAnswer({ cancelled: false }), null)
})
