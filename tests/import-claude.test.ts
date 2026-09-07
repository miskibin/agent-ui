import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, truncateSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

/**
 * Reading Claude Code's own history out of `~/.claude/projects`.
 *
 * The fixtures below are synthesized rather than copied from a real home for
 * the obvious reason, but every field they carry is one the CLI writes, and
 * every field the parser ignores is one a real transcript is full of —
 * sidechains, hook records, tool results, image blocks. The point of most of
 * these tests is what does *not* come back.
 */

const CLAUDE_HOME = mkdtempSync(join(tmpdir(), "agent-ui-claude-home-"))
process.env.CLAUDE_CONFIG_DIR = CLAUDE_HOME

const {
  claudeProjects,
  claudeProjectsDir,
  loadClaudeConversation,
  parseClaudeTranscript,
  scanClaudeTranscripts,
} = await import("@/lib/import/claude-history")
const { MAX_IMPORTED_MESSAGES, isResumableSessionId, readRecords } =
  await import("@/lib/import/jsonl")

const SESSION_A = "0f8fad5b-d9cb-469f-a165-70867728950e"
const SESSION_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

/** A transcript under one of the CLI's escaped project directories. */
function writeTranscript(
  slug: string,
  name: string,
  lines: unknown[],
  mtimeMs = Date.now()
) {
  const directory = join(claudeProjectsDir(), slug)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${name}.jsonl`)
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
  const seconds = mtimeMs / 1000
  utimesSync(path, seconds, seconds)
  return path
}

function userLine(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    cwd: "/tmp/does-not-matter",
    sessionId: SESSION_A,
    timestamp: "2026-01-01T10:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  }
}

function assistantLine(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    cwd: "/tmp/does-not-matter",
    sessionId: SESSION_A,
    timestamp: "2026-01-01T10:00:05.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text }],
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        cache_read_input_tokens: 900,
      },
    },
    ...extra,
  }
}

test("a session id is only kept when --resume would take it", () => {
  assert.equal(isResumableSessionId(SESSION_A), true)
  for (const bad of ["", "not-a-uuid", "0f8fad5b", `${SESSION_A}x`, "../../etc"]) {
    assert.equal(isResumableSessionId(bad), false, bad)
  }
})

test("the folder comes from the transcript, never from the directory name", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-ui-workspace-"))
  const other = mkdtempSync(join(tmpdir(), "agent-ui-workspace-"))
  // The slug is deliberately lossy — nothing may decode it.
  writeTranscript(
    "-Users-someone-code-app",
    SESSION_A,
    [
      { ...userLine("first"), cwd: workspace },
      { ...assistantLine("hello"), cwd: workspace },
    ],
    Date.parse("2026-02-01T00:00:00.000Z")
  )
  writeTranscript(
    "-Users-someone-code-app",
    SESSION_B,
    [
      { ...userLine("second"), sessionId: SESSION_B, cwd: other },
      { ...assistantLine("hi"), sessionId: SESSION_B, cwd: other },
    ],
    Date.parse("2026-03-01T00:00:00.000Z")
  )

  const scan = await scanClaudeTranscripts()
  assert.deepEqual(
    [...scan.byCwd.keys()].sort(),
    [workspace, other].sort(),
    "two transcripts in one slug directory, two different folders"
  )

  const projects = claudeProjects(scan)
  assert.equal(projects.length, 2)
  // Newest first.
  assert.equal(projects[0].cwd, other)
  assert.equal(projects[0].conversations, 1)
  assert.equal(projects[0].provider, "claude-code")
  assert.equal(projects[0].resumable, true)
  assert.equal(projects[0].lastActiveAt, Date.parse("2026-03-01T00:00:00.000Z"))
})

test("a subagent's transcript, hook lines and compaction summaries are dropped", () => {
  const conversation = parseClaudeTranscript(
    [
      userLine("what does this repo do?"),
      { ...userLine("<system-reminder>a hook wrote this</system-reminder>"), isMeta: true },
      { ...userLine("explore the tests"), isSidechain: true },
      { ...assistantLine("a subagent answered"), isSidechain: true },
      { ...assistantLine("previously, the user asked…"), isCompactSummary: true },
      assistantLine("it is a chat app."),
    ],
    { sourcePath: "/x.jsonl", fallbackSessionId: SESSION_A, mtimeMs: 1 }
  )
  assert.ok(conversation)
  assert.deepEqual(
    conversation.messages.map((message) => message.text),
    ["what does this repo do?", "it is a chat app."]
  )
})

test("tool calls, tool results and pasted images never become messages", () => {
  const conversation = parseClaudeTranscript(
    [
      userLine("read lib/store/sessions.ts"),
      {
        type: "assistant",
        cwd: "/repo",
        sessionId: SESSION_A,
        message: {
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [
            { type: "text", text: "Reading it now." },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
          ],
        },
      },
      {
        type: "user",
        cwd: "/repo",
        sessionId: SESSION_A,
        toolUseResult: { stdout: "500 lines of a file" },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "500 lines" }],
        },
      },
      {
        type: "user",
        cwd: "/repo",
        sessionId: SESSION_A,
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", data: "iVBORw0KGgo=" } },
          ],
        },
      },
      assistantLine("It is the JSON store."),
    ],
    { sourcePath: "/x.jsonl", fallbackSessionId: SESSION_A, mtimeMs: 1 }
  )
  assert.ok(conversation)
  assert.deepEqual(
    conversation.messages.map((message) => `${message.role}:${message.text}`),
    [
      "user:read lib/store/sessions.ts",
      "assistant:Reading it now.",
      "assistant:It is the JSON store.",
    ]
  )
})

test("an assistant turn keeps the model and the usage the transcript reported", () => {
  const conversation = parseClaudeTranscript(
    [userLine("hi"), assistantLine("hello")],
    { sourcePath: "/x.jsonl", fallbackSessionId: SESSION_A, mtimeMs: 1 }
  )
  assert.ok(conversation)
  assert.equal(conversation.model, "claude-sonnet-4-5-20250929")
  assert.equal(conversation.sessionId, SESSION_A)
  assert.equal(conversation.title, "hi")
  const answer = conversation.messages[1]
  assert.equal(answer.model, "claude-sonnet-4-5-20250929")
  assert.deepEqual(answer.usage, {
    inputTokens: 120,
    outputTokens: 40,
    cachedInputTokens: 900,
  })
  assert.equal(conversation.messages[0].usage, undefined)
})

test("the '<synthetic>' sentinel is never offered as a model", () => {
  const conversation = parseClaudeTranscript(
    [
      userLine("hi"),
      {
        type: "assistant",
        cwd: "/repo",
        sessionId: SESSION_A,
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "API error." }],
        },
      },
    ],
    { sourcePath: "/x.jsonl", fallbackSessionId: SESSION_A, mtimeMs: 1 }
  )
  assert.ok(conversation)
  assert.equal(conversation.model, undefined)
  assert.equal(conversation.messages[1].model, undefined)
})

test("a session id that is not a UUID leaves the conversation unresumable", () => {
  const conversation = parseClaudeTranscript(
    [{ ...userLine("hi"), sessionId: "resume-me-please" }],
    { sourcePath: "/x.jsonl", fallbackSessionId: "also-not-a-uuid", mtimeMs: 1 }
  )
  assert.ok(conversation)
  assert.equal(conversation.sessionId, undefined)
})

test("a transcript with no visible user turn is not a conversation", () => {
  assert.equal(
    parseClaudeTranscript([assistantLine("nobody asked")], {
      sourcePath: "/x.jsonl",
      fallbackSessionId: SESSION_A,
      mtimeMs: 1,
    }),
    null
  )
})

test("only the newest 200 visible turns are kept", () => {
  const lines: Record<string, unknown>[] = []
  for (let index = 0; index < 400; index += 1) {
    lines.push(userLine(`turn ${index}`))
  }
  const conversation = parseClaudeTranscript(lines, {
    sourcePath: "/x.jsonl",
    fallbackSessionId: SESSION_A,
    mtimeMs: 1,
  })
  assert.ok(conversation)
  assert.equal(conversation.messages.length, MAX_IMPORTED_MESSAGES)
  assert.equal(conversation.messages[0].text, "turn 200")
  assert.equal(conversation.messages.at(-1)?.text, "turn 399")
})

test("a malformed line costs that line and nothing else", async () => {
  const path = writeTranscript("-broken", SESSION_A, [])
  writeFileSync(
    path,
    [
      JSON.stringify(userLine("still here")),
      "{not json at all",
      "",
      JSON.stringify(assistantLine("and so is this")),
    ].join("\n")
  )
  const conversation = await loadClaudeConversation({
    path,
    size: 4096,
    mtimeMs: Date.now(),
  })
  assert.ok(conversation)
  assert.deepEqual(
    conversation.messages.map((message) => message.text),
    ["still here", "and so is this"]
  )
})

test("a transcript past 16 MiB is skipped rather than read", async () => {
  const path = writeTranscript("-huge", SESSION_B, [userLine("hi")])
  truncateSync(path, 17 * 1024 * 1024)
  assert.equal(
    await readRecords({ path, size: 17 * 1024 * 1024, mtimeMs: Date.now() }),
    null
  )
  assert.equal(
    await loadClaudeConversation({
      path,
      size: 17 * 1024 * 1024,
      mtimeMs: Date.now(),
    }),
    null
  )
})
