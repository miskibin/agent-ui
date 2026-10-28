import assert from "node:assert/strict"
import { test } from "node:test"

import {
  MAX_DIGEST_PATHS,
  createProgress,
  digestProgress,
  finishProgress,
  trackEvent,
} from "@/lib/subagents/progress"

/**
 * The digest an orchestrator polls: small, factual, and incremental past a
 * cursor — every byte of it lands in another agent's context.
 */

const T0 = 1_700_000_000_000

function tool(
  id: string,
  name: string,
  status: "running" | "done" | "error",
  input?: object,
  extra: { exitCode?: number; output?: string } = {}
) {
  return {
    type: "tool" as const,
    id,
    name,
    status,
    ...(input ? { input: JSON.stringify(input) } : null),
    ...extra,
  }
}

test("a running tool is what the run is doing, and a stall shows as idle time", () => {
  const p = createProgress(T0)
  trackEvent(p, tool("t1", "Bash", "running", { command: "npm test" }), T0 + 1000)
  const digest = digestProgress(p, T0 + 61_000)
  assert.equal(digest.phase, "tool")
  assert.equal(digest.doing, "Bash: npm test")
  assert.equal(digest.idle_seconds, 60)
  assert.equal(digest.steps, 0)
})

test("the closing event borrows the opening one's arguments", () => {
  const p = createProgress(T0)
  trackEvent(p, tool("t1", "Edit", "running", { file_path: "lib/a.ts" }), T0)
  // pi's end event carries no args at all.
  trackEvent(p, tool("t1", "Edit", "done"), T0 + 2000)
  const digest = digestProgress(p, T0 + 2000, { detail: "full" })
  assert.deepEqual(digest.files_edited, ["lib/a.ts"])
  assert.deepEqual(digest.log, ["#1 +2s Edit lib/a.ts"])
  assert.equal(digest.doing, undefined)
})

test("commands, test runs, exit codes and errors are counted, not narrated", () => {
  const p = createProgress(T0)
  trackEvent(p, tool("a", "Bash", "done", { command: "npm test" }, { exitCode: 1 }), T0 + 1000)
  trackEvent(p, tool("b", "Bash", "done", { command: "npm test" }, { exitCode: 0 }), T0 + 2000)
  trackEvent(p, tool("c", "Bash", "done", { command: "ls" }), T0 + 3000)
  trackEvent(p, tool("d", "Read", "done", { path: "x.ts" }), T0 + 3500)
  trackEvent(p, tool("e", "Edit", "error", { path: "y.ts" }, { output: "old_string not found" }), T0 + 4000)
  const digest = digestProgress(p, T0 + 4000)
  assert.equal(digest.commands, 3)
  assert.equal(digest.commands_failed, 1)
  assert.deepEqual(digest.test_runs, { passed: 1, failed: 1 })
  assert.equal(digest.files_read, 1)
  assert.equal(digest.tool_errors, 1)
  assert.equal(digest.last_error, "Edit: old_string not found")
  // A failed edit changed nothing.
  assert.equal(digest.files_edited, undefined)
  // Brief carries no log at all.
  assert.equal(digest.log, undefined)
})

test("since_step returns only what is new", () => {
  const p = createProgress(T0)
  for (let i = 1; i <= 5; i++) {
    trackEvent(p, tool(`t${i}`, "Read", "done", { path: `f${i}.ts` }), T0 + i * 1000)
  }
  const digest = digestProgress(p, T0 + 5000, { sinceStep: 3 })
  assert.deepEqual(digest.log, ["#4 +4s Read f4.ts", "#5 +5s Read f5.ts"])
  assert.equal(digest.steps, 5)
  assert.equal(digestProgress(p, T0, { sinceStep: 5 }).log?.toString(), "")
})

test("a question to the user is surfaced while it is open", () => {
  const p = createProgress(T0)
  const request = { requestId: "q1", kind: "permission", title: "Run rm -rf build?", options: [{ id: "y", label: "Yes" }] }
  trackEvent(p, { type: "tool", id: "q", name: "permission", status: "running", input: JSON.stringify(request) }, T0)
  assert.deepEqual(digestProgress(p, T0).waiting_on_user, { kind: "permission", title: "Run rm -rf build?" })
  assert.equal(digestProgress(p, T0).phase, "waiting_on_user")
  trackEvent(p, { type: "tool", id: "q", name: "permission", status: "done" }, T0 + 1)
  assert.equal(digestProgress(p, T0).waiting_on_user, undefined)
})

test("many edited files become a list plus a count", () => {
  const p = createProgress(T0)
  for (let i = 0; i < MAX_DIGEST_PATHS + 3; i++) {
    trackEvent(p, tool(`t${i}`, "Write", "done", { path: `f${i}.ts` }), T0)
  }
  const digest = digestProgress(p, T0)
  assert.equal((digest.files_edited as string[]).length, MAX_DIGEST_PATHS)
  assert.equal(digest.files_edited_more, 3)
})

test("a finished run reports no idle time and keeps its usage", () => {
  const p = createProgress(T0)
  trackEvent(p, { type: "done", usage: { input: 1200, output: 300 } }, T0 + 5000)
  finishProgress(p, T0 + 5000)
  const digest = digestProgress(p, T0 + 99_000)
  assert.equal(digest.phase, "finished")
  assert.equal(digest.idle_seconds, undefined)
  assert.deepEqual(digest.tokens, { in: 1200, out: 300 })
})

test("full detail carries the tail of the latest output, capped", () => {
  const p = createProgress(T0)
  const digest = digestProgress(p, T0, { detail: "full", output: "x".repeat(5000) })
  assert.ok((digest.latest_output as string).length <= 1201)
})
