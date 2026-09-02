import assert from "node:assert/strict"
import { test } from "node:test"

import { APP_SLASH_COMMANDS, parseSlashCommand } from "@/lib/slash-commands"

/**
 * The composer runs these before anything reaches a model. Everything the
 * parser does *not* claim is sent to the agent as typed, which is what keeps a
 * harness's own `/compact` or `/review` working — so a false positive here
 * silently swallows a prompt.
 */

test("a bare command parses with an empty argument", () => {
  assert.deepEqual(parseSlashCommand("/new"), { name: "new", arg: "" })
  assert.deepEqual(parseSlashCommand("  /settings  "), { name: "settings", arg: "" })
})

test("the argument keeps its spaces and its case", () => {
  assert.deepEqual(parseSlashCommand("/rename Fix the build"), {
    name: "rename",
    arg: "Fix the build",
  })
  assert.deepEqual(parseSlashCommand("/rename   Fix   the   build   "), {
    name: "rename",
    arg: "Fix   the   build",
  })
  // A multi-line argument is still one argument.
  assert.deepEqual(parseSlashCommand("/rename one\ntwo"), {
    name: "rename",
    arg: "one\ntwo",
  })
})

test("the command name is case-insensitive", () => {
  assert.deepEqual(parseSlashCommand("/Rename Title"), { name: "rename", arg: "Title" })
})

test("an unknown command is left for the agent", () => {
  assert.equal(parseSlashCommand("/compact"), null)
  assert.equal(parseSlashCommand("/review this"), null)
})

test("text that merely contains a slash is not a command", () => {
  assert.equal(parseSlashCommand("please /rename this chat"), null)
  assert.equal(parseSlashCommand("/"), null)
  assert.equal(parseSlashCommand("//rename"), null)
  assert.equal(parseSlashCommand("/1rename"), null)
  assert.equal(parseSlashCommand(""), null)
})

test("every listed command is one the parser recognises", () => {
  for (const command of APP_SLASH_COMMANDS) {
    assert.deepEqual(parseSlashCommand(`/${command.name}`), {
      name: command.name,
      arg: "",
    })
  }
})
