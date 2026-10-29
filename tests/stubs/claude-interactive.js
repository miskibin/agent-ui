/* eslint-disable @typescript-eslint/no-require-imports */
// Deterministic subprocess fixture: exercises the real JSONL adapter without a model.
const { createInterface } = require("node:readline")
const assert = require("node:assert/strict")
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n")
const session_id = "stub-claude-session"
let input
let background = false
const finish = (text) => {
  send({ type: "assistant", session_id, message: { id: "answer", model: "sonnet", content: [{ type: "text", text }] } })
  send({ type: "result", subtype: "success", session_id, is_error: false, result: text })
}
send({ type: "system", subtype: "init", session_id, model: "sonnet" })
createInterface({ input: process.stdin }).on("line", (line) => {
  const value = JSON.parse(line)
  if (value.type === "control_request") {
    assert.equal(value.request.subtype, "initialize")
    send({ type: "control_response", response: { subtype: "success", request_id: value.request_id, response: {} } })
  } else if (value.type === "user") {
    assert.ok(process.argv.includes("--input-format"))
    assert.ok(process.argv.includes("--permission-prompt-tool"))
    input = value.message.content
    background = input.some((part) => part.text?.includes("background-check"))
    if (background) {
      send({ type: "system", subtype: "task_started", task_id: "native-child", task_type: "local_agent" })
      send({ type: "result", subtype: "success", session_id, is_error: false, result: "Child is working" })
    }
    if (input.some((part) => part.text?.includes("inherit-check"))) {
      assert.equal(process.argv[process.argv.indexOf("--model") + 1], "sonnet")
      assert.equal(process.argv[process.argv.indexOf("--effort") + 1], "high")
    }
    if (input.some((part) => part.text?.includes("exit-while-waiting"))) {
      send({ type: "control_request", request_id: "p", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo permission" } } })
      setTimeout(() => process.exit(1), 100)
      return
    }
    send({ type: "control_request", request_id: "p", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo permission" } } })
  } else if (value.type === "control_response" && value.response.request_id === "p") {
    if (value.response.response.behavior !== "allow") { finish("permission denied"); return }
    assert.deepEqual(value.response.response.updatedInput, { command: "echo permission" })
    if (background) send({ type: "system", subtype: "task_notification", task_id: "native-child", status: "completed" })
    const questions = [{ question: "Which checks?", options: [{ label: "Lint" }, { label: "Tests" }], multiSelect: true }]
    send({ type: "assistant", session_id, message: { id: "question", content: [{ type: "tool_use", id: "q-tool", name: "AskUserQuestion", input: { questions } }] } })
    send({ type: "control_request", request_id: "q", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions } } })
  } else if (value.type === "control_response" && value.response.request_id === "q") {
    const answer = value.response.response.updatedInput?.answers?.["Which checks?"]
    finish(`same-turn: ${answer}; image=${input.some((part) => part.type === "image" && part.source.media_type === "image/png")}`)
  }
}).on("close", () => process.exit(0))
