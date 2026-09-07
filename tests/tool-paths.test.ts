import assert from "node:assert/strict"
import { test } from "node:test"

import { looksLikeTestCommand, toolJournalEvent } from "@/lib/handoff/journal"
import {
  collectToolPaths,
  commandProgram,
  commandSegments,
  commandTokens,
  extractToolCommand,
  stripTrailingExitCode,
} from "@/lib/tool-paths"

/**
 * What a tool call was about, dug out of payloads no harness spells the same
 * way — and the journal entry that is built from it.
 */

test("the flat spellings every harness uses are all read", () => {
  assert.deepEqual(
    collectToolPaths({ path: "a.ts", file_path: "b.ts", target_file: "c.ts" }),
    ["a.ts", "b.ts", "c.ts"]
  )
  assert.deepEqual(collectToolPaths({ paths: ["a.ts", "a.ts", "b.ts"] }), ["a.ts", "b.ts"])
})

test("nested payloads are walked, not indexed", () => {
  assert.deepEqual(
    collectToolPaths({
      item: { input: { filePath: "lib/a.ts" } },
      locations: [{ path: "lib/b.ts" }, { path: "lib/c.ts" }],
      rawInput: { newPath: "lib/d.ts" },
    }),
    // Order follows the container list, not the object's key order.
    ["lib/b.ts", "lib/c.ts", "lib/a.ts", "lib/d.ts"]
  )
})

test("the walk is bounded in depth and in count", () => {
  const deep = { data: { data: { data: { data: { data: { path: "far.ts" } } } } } }
  assert.deepEqual(collectToolPaths(deep), [])
  const many = { paths: Array.from({ length: 40 }, (_, index) => `f${index}.ts`) }
  assert.equal(collectToolPaths(many).length, 8)
  assert.equal(collectToolPaths(many, { maxPaths: 3 }).length, 3)
})

test("prose is not a path just because it sits in a payload", () => {
  assert.deepEqual(collectToolPaths({ description: "edit lib/a.ts", output: "done" }), [])
  assert.deepEqual(collectToolPaths(undefined), [])
  assert.deepEqual(collectToolPaths("lib/a.ts"), [])
})

test("the command is found under any of its spellings", () => {
  assert.equal(extractToolCommand({ command: "npm test" }), "npm test")
  assert.equal(extractToolCommand({ item: { input: { command: "ls -la" } } }), "ls -la")
  assert.equal(extractToolCommand({ rawInput: { command: ["npm", "run", "build"] } }), "npm run build")
  assert.equal(extractToolCommand({ rawInput: { executable: "git", args: ["status"] } }), "git status")
  assert.equal(extractToolCommand({ rawInput: { executable: "git" } }), "git")
  assert.equal(extractToolCommand({}, "Ran `pytest -q`"), "pytest -q")
  assert.equal(extractToolCommand({}, "Ran a command"), undefined)
  assert.equal(extractToolCommand(undefined), undefined)
})

test("an echoed exit code is not part of the command", () => {
  assert.equal(stripTrailingExitCode("npm test <exited with exit code 1>"), "npm test")
  assert.equal(extractToolCommand({ command: "ls <exited with exit code 0>" }), "ls")
  assert.equal(stripTrailingExitCode("   "), undefined)
})

test("the program is the first token, minus its path, extension and wrappers", () => {
  assert.equal(commandProgram("/usr/local/bin/npm test"), "npm")
  assert.equal(commandProgram("C:\\Program\\node.EXE server.js"), "node")
  assert.equal(commandProgram("NODE_ENV=test sudo npm test"), "npm")
  assert.equal(commandProgram("   "), "")
  assert.deepEqual(commandTokens("npm run test"), { program: "npm", args: ["run", "test"] })
  assert.deepEqual(commandSegments("cd api && npm test | tee out"), ["cd api", "npm test", "tee out"])
})

test("a test run is recognized by what it invokes, not by the word 'test'", () => {
  for (const command of [
    "npm test",
    "npm run test -- --watch=false",
    "pnpm test",
    "yarn run test:unit",
    "npx vitest run",
    "pytest -q",
    "cargo test",
    "go test ./...",
    "python -m pytest",
    "make test",
    "cd api && npm test",
    "/usr/local/bin/pytest tests/",
  ]) {
    assert.equal(looksLikeTestCommand(command), true, command)
  }
  for (const command of [
    "npm run build",
    "git status",
    "ls tests",
    "git commit -m 'add a test'",
    "cat lib/test-helpers.ts",
    "echo test",
  ]) {
    assert.equal(looksLikeTestCommand(command), false, command)
  }
})

test("a journal entry keeps the nested path and the nested command", () => {
  assert.deepEqual(
    toolJournalEvent({
      type: "tool",
      id: "a",
      name: "Edit",
      status: "done",
      input: JSON.stringify({ item: { input: { filePath: "lib/a.ts" } } }),
    }),
    { name: "Edit", status: "done", paths: ["lib/a.ts"] }
  )
  assert.deepEqual(
    toolJournalEvent({
      type: "tool",
      id: "b",
      name: "shell",
      status: "error",
      input: JSON.stringify({ rawInput: { executable: "npm", args: ["test"] } }),
      exitCode: 1,
    }),
    { name: "shell", status: "error", command: "npm test", exitCode: 1 }
  )
})
