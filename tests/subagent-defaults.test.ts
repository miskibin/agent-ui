import assert from "node:assert/strict"
import test from "node:test"
import { resolveSubagentDefaults, subagentPermission } from "@/lib/subagents/defaults"
import { parseRunArgs } from "@/lib/subagents/mcp"

test("delegating a task inherits the current harness, model and effort without discovery", () => {
  const parent = { harness: "pi", model: "openrouter/model", effort: "high" }
  assert.deepEqual(resolveSubagentDefaults({}, {}, parent), parent)
  assert.deepEqual(resolveSubagentDefaults({ model: "other", effort: "low" }, {}, parent), { ...parent, model: "other", effort: "low" })
})
test("model and effort never leak across harnesses; a continued child keeps its own model", () => {
  const parent = { harness: "claudeCode", model: "opus", effort: "max" }
  assert.deepEqual(resolveSubagentDefaults({ harness: "codex" }, {}, parent), { harness: "codex", model: undefined, effort: undefined })
  assert.deepEqual(resolveSubagentDefaults({}, { harness: "pi", model: "ollama/local" }, parent), { harness: "pi", model: "ollama/local", effort: undefined })
  assert.throws(() => resolveSubagentDefaults({}), /Specify harness/)
})
test("inherited permission cannot silently become a more permissive backend default", () => {
  const capabilities = { tools: true, resume: true, vision: false, effort: false, permissionModes: ["full" as const] }
  assert.throws(() => subagentPermission("read-only", capabilities), /cannot enforce/)
  assert.throws(() => subagentPermission("plan", capabilities), /cannot enforce/)
  assert.equal(subagentPermission("full", capabilities), "full")
  assert.equal(subagentPermission("read-only", { ...capabilities, tools: false }), undefined)
  assert.equal(subagentPermission("full", { ...capabilities, permissionModes: undefined }), undefined)
})
test("old calls remain accepted and worktree isolation must be explicit and valid", () => {
  assert.equal(typeof parseRunArgs({ harness: "pi", prompt: "Task" }), "object")
  assert.equal(typeof parseRunArgs({ prompt: "Task", isolation: "worktree", effort: "high" }), "object")
  assert.equal(typeof parseRunArgs({ prompt: "Task", isolation: "surprise" }), "string")
})
