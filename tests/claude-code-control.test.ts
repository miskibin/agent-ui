import assert from "node:assert/strict"
import test from "node:test"
import { ClaudeCodeControl, claudeUserMessage } from "@/lib/claude-code-control"
import { buildArgs, permissionArgs } from "@/lib/claude-code-protocol"
import { createAskUser, answerUserRequest, listUserRequests, parseUserRequestInput } from "@/lib/turn-requests"
import type { AgentStreamEvent } from "@/lib/providers/types"
import { AsyncEventQueue } from "@/lib/async-event-queue"

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
function setup(sessionId: string, permissionMode: "edits" | "plan" = "edits") {
  const sent: Array<{ response: { response?: { behavior: string; updatedInput?: unknown }; subtype: string } }> = []
  const events: AgentStreamEvent[] = []
  const control = new ClaudeCodeControl({ send: (value) => sent.push(value as typeof sent[number]),
    emit: (event) => events.push(event), askUser: createAskUser({ sessionId }), permissionMode })
  return { control, sent, events }
}
const request = (id: string, tool: string, input: unknown) => ({ type: "control_request", request_id: id,
  request: { subtype: "can_use_tool", tool_name: tool, input } })

test("permission is registered before publishing, and allows the original input only after an answer", async () => {
  const { control, events, sent } = setup("claude-allow")
  const input = { command: "bun run test" }
  control.handle(request("p1", "Bash", input))
  assert.equal(sent.length, 0)
  const event = events[0]
  assert.equal(event.type, "tool")
  if (event.type !== "tool") throw new Error("missing tool")
  const question = parseUserRequestInput(event.input)!
  assert.deepEqual(question.tool, { name: "Bash", input })
  assert.equal(listUserRequests("claude-allow").length, 1)
  answerUserRequest("claude-allow", question.id, { optionId: "allow" })
  await flush()
  assert.deepEqual(sent[0].response.response, { behavior: "allow", updatedInput: input })
  assert.equal(listUserRequests("claude-allow").length, 0)
  const last = events.at(-1)
  assert.equal(last?.type === "tool" && last.status, "done")
  await control.close()
})

test("questions, multi-select and free text return answers within the same tool request", async () => {
  const { control, sent } = setup("claude-questions")
  const questions = [
    { question: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: true },
    { question: "Name?", options: [{ label: "Suggested" }] },
  ]
  control.handle(request("q", "AskUserQuestion", { questions }))
  const first = listUserRequests("claude-questions")[0].request
  assert.equal(first.allowMultiple, true)
  answerUserRequest("claude-questions", first.id, { optionIds: ["0", "1"] })
  await flush()
  assert.equal(sent.length, 0)
  answerUserRequest("claude-questions", listUserRequests("claude-questions")[0].request.id, { text: "Custom name" })
  await flush()
  assert.deepEqual(sent[0].response.response, { behavior: "allow", updatedInput: {
    questions, answers: { "Which?": "A, B", "Name?": "Custom name" },
  } })
  await control.close()
})

test("CLI cancellation clears just its own request and sends no obsolete response", async () => {
  const { control, sent } = setup("claude-cancel")
  control.handle(request("one", "Bash", {}))
  control.handle(request("two", "Write", {}))
  control.handle({ type: "control_cancel_request", request_id: "one" })
  await flush()
  assert.equal(listUserRequests("claude-cancel").length, 1)
  assert.equal(sent.length, 0)
  await control.close()
  assert.equal(listUserRequests("claude-cancel").length, 0)
  assert.equal(sent.length, 0)
})

test("denial, missing channel and unknown control requests fail closed", async () => {
  const { control, sent } = setup("claude-deny")
  control.handle(request("p", "Bash", {}))
  answerUserRequest("claude-deny", listUserRequests("claude-deny")[0].request.id, { cancelled: true })
  await flush()
  assert.equal(sent[0].response.response?.behavior, "deny")
  control.handle({ type: "control_request", request_id: "unknown", request: { subtype: "not-supported" } })
  assert.equal(sent[1].response.subtype, "error")
  await control.close()
  const noChannel: unknown[] = []
  const headless = new ClaudeCodeControl({ send: (frame) => noChannel.push(frame), emit: () => {}, permissionMode: "edits" })
  headless.handle(request("p", "Bash", {}))
  await flush()
  assert.equal(noChannel.length, 1)
  await headless.close()
})

test("plan stays plan until the user changes the chat mode", async () => {
  const { control, sent } = setup("claude-plan", "plan")
  assert.deepEqual(permissionArgs("plan"), ["--permission-mode", "plan"])
  control.handle(request("exit", "ExitPlanMode", {}))
  await flush()
  assert.equal(sent[0].response.response?.behavior, "deny")
  assert.equal(listUserRequests("claude-plan").length, 0)
  control.handle(request("write", "Write", { file_path: "unsafe.txt", content: "no" }))
  await flush()
  assert.equal(sent[1].response.response?.behavior, "deny")
  assert.equal(listUserRequests("claude-plan").length, 0)
  await control.close()
})

test("streaming input is opt-in and images carry their detected MIME", () => {
  assert.ok(!buildArgs({ permissionMode: "edits" }).includes("--input-format"))
  const argv = buildArgs({ permissionMode: "edits", streamingInput: true })
  assert.ok(argv.includes("--input-format"))
  assert.ok(argv.includes("--permission-prompt-tool"))
  const message = claudeUserMessage("Review", ["/9j/AAAA"])
  assert.deepEqual(message.message.content[0], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/AAAA" } })
  assert.deepEqual(message.message.content[1], { type: "text", text: "Review" })
})

test("event queue drains callbacks and wakes on closure", async () => {
  const queue = new AsyncEventQueue<number>()
  const received: number[] = []
  const consume = (async () => { for await (const value of queue) received.push(value) })()
  queue.push(1)
  await flush()
  queue.push(2)
  queue.close()
  queue.push(3)
  await consume
  assert.deepEqual(received, [1, 2])
})
