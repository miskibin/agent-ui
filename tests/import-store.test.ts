import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

/**
 * Writing a CLI's conversations into this app's store.
 *
 * The two things worth pinning down: what an imported chat *is* once it lands
 * (a chat with the CLI's session id under `agentSessions`, so the next turn
 * resumes rather than starting over), and that importing twice does not
 * produce it twice.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), "agent-ui-import-store-"))
const CLAUDE_HOME = mkdtempSync(join(tmpdir(), "agent-ui-import-claude-"))
const CODEX_HOME = mkdtempSync(join(tmpdir(), "agent-ui-import-codex-"))
const WORKSPACE = mkdtempSync(join(tmpdir(), "agent-ui-import-workspace-"))
const OTHER_WORKSPACE = mkdtempSync(join(tmpdir(), "agent-ui-import-other-"))

process.env.AGENT_UI_DIR = DATA_DIR
process.env.CLAUDE_CONFIG_DIR = CLAUDE_HOME
process.env.CODEX_HOME = CODEX_HOME

const { importConversations, scanImports } = await import("@/lib/import/import")
const { listSessions, readMessages } = await import("@/lib/store/sessions")
const { readLedger } = await import("@/lib/import/ledger")

const SESSION_A = "0f8fad5b-d9cb-469f-a165-70867728950e"
const SESSION_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
const SESSION_C = "1b4e28ba-2fa1-4d9b-a1e2-3c4d5e6f7a8b"
const CODEX_SESSION = "5b8f2e14-3c9a-4d21-b8e6-0a1b2c3d4e5f"

function writeClaude(id: string, cwd: string, prompt: string, mtimeMs: number) {
  const directory = join(CLAUDE_HOME, "projects", "-slug")
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${id}.jsonl`)
  writeFileSync(
    path,
    [
      {
        type: "user",
        cwd,
        sessionId: id,
        timestamp: "2026-01-01T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      },
      {
        type: "assistant",
        cwd,
        sessionId: id,
        timestamp: "2026-01-01T10:00:09.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: `Answering: ${prompt}` }],
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n"
  )
  const seconds = mtimeMs / 1000
  utimesSync(path, seconds, seconds)
}

function writeCodex(id: string, cwd: string, prompt: string, mtimeMs: number) {
  const directory = join(CODEX_HOME, "sessions", "2026", "01", "05")
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `rollout-2026-01-05T10-00-00-${id}.jsonl`)
  writeFileSync(
    path,
    [
      { type: "session_meta", payload: { id, cwd } },
      { type: "event_msg", payload: { type: "user_message", message: prompt } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n"
  )
  const seconds = mtimeMs / 1000
  utimesSync(path, seconds, seconds)
}

writeClaude(SESSION_A, WORKSPACE, "first question", Date.parse("2026-01-01T00:00:00Z"))
writeClaude(SESSION_B, WORKSPACE, "second question", Date.parse("2026-01-02T00:00:00Z"))
writeClaude(SESSION_C, OTHER_WORKSPACE, "another repo", Date.parse("2026-01-03T00:00:00Z"))
writeCodex(CODEX_SESSION, WORKSPACE, "codex question", Date.parse("2026-01-04T00:00:00Z"))

test("the scan lists one row per folder per CLI, newest first", async () => {
  const { projects } = await scanImports()
  assert.deepEqual(
    projects.map((project) => [project.provider, project.cwd, project.conversations]),
    [
      ["codex", WORKSPACE, 1],
      ["claude-code", OTHER_WORKSPACE, 1],
      ["claude-code", WORKSPACE, 2],
    ]
  )
  assert.equal(projects[0].resumable, false, "nothing here runs Codex")
  assert.equal(projects[1].resumable, true)
})

test("only the folders the request names are imported", async () => {
  const result = await importConversations({
    provider: "claude-code",
    cwds: [WORKSPACE],
  })
  assert.deepEqual(result, { imported: 2, skipped: 0 })

  const sessions = await listSessions()
  assert.equal(sessions.length, 2)
  assert.equal(
    sessions.every((session) => session.cwd === WORKSPACE),
    true,
    "the other repo was not asked for"
  )
  // Imported oldest-first, so the newest conversation is the newest chat.
  assert.equal(sessions[0].title, "second question")
  assert.equal(sessions[1].title, "first question")
})

test("an imported chat carries the session id its CLI would resume", async () => {
  const sessions = await listSessions()
  const chat = sessions.find((session) => session.title === "first question")
  assert.ok(chat)
  assert.equal(chat.providerId, "claudeCode")
  assert.equal(chat.model, "claude-sonnet-4-5-20250929")
  assert.equal(chat.cwd, WORKSPACE)
  assert.equal(chat.providerSessionId, SESSION_A, "the legacy field is written too")
  assert.equal(chat.agentSessions?.claudeCode?.providerSessionId, SESSION_A)
  assert.equal(chat.agentSessions?.claudeCode?.cwd, WORKSPACE)
  assert.equal(chat.messageCount, 2)

  const messages = await readMessages(chat.id)
  assert.deepEqual(
    messages.map((message) => [message.sender, message.content]),
    [
      ["user", "first question"],
      ["assistant", "Answering: first question"],
    ]
  )
  assert.equal(messages[0].createdAt, Date.parse("2026-01-01T10:00:00.000Z"))
  assert.equal(messages[0].metadata?.typedText, "first question")
  assert.equal(messages[1].metadata?.providerId, "claudeCode")
  assert.equal(messages[1].metadata?.inputTokens, 10)
  assert.equal(messages[1].metadata?.outputTokens, 4)
  assert.equal(messages[1].metadata?.tokens, 14)
  assert.equal(messages[1].metadata?.finishedAt, Date.parse("2026-01-01T10:00:09.000Z"))
})

test("importing the same folder again brings nothing over twice", async () => {
  const result = await importConversations({
    provider: "claude-code",
    cwds: [WORKSPACE],
  })
  assert.deepEqual(result, { imported: 0, skipped: 2 })
  assert.equal((await listSessions()).length, 2)
})

test("the ledger remembers what came from where", async () => {
  const ledger = await readLedger()
  assert.equal(ledger.entries.length, 2)
  assert.deepEqual(
    ledger.entries.map((entry) => entry.providerSessionId).sort(),
    [SESSION_A, SESSION_B].sort()
  )
  assert.equal(
    ledger.entries.every((entry) => entry.provider === "claude-code"),
    true
  )
  const raw: unknown = JSON.parse(readFileSync(join(DATA_DIR, "imports.json"), "utf8"))
  assert.equal((raw as { version: number }).version, 1)
})

test("a Codex conversation is imported as history, with nothing to resume", async () => {
  const result = await importConversations({ provider: "codex" })
  assert.deepEqual(result, { imported: 1, skipped: 0 })

  const chat = (await listSessions()).find(
    (session) => session.title === "codex question"
  )
  assert.ok(chat)
  assert.equal(chat.providerId, "", "no backend here can carry it on")
  assert.equal(chat.providerSessionId, undefined)
  assert.equal(chat.agentSessions, undefined)
  assert.equal(chat.cwd, WORKSPACE)

  const messages = await readMessages(chat.id)
  assert.deepEqual(
    messages.map((message) => message.content),
    ["codex question", "Done."]
  )

  // Deduped through the ledger, since there is no session id in the index.
  assert.deepEqual(await importConversations({ provider: "codex" }), {
    imported: 0,
    skipped: 1,
  })
})

test("a chat the user resumed by hand is not imported underneath it", async () => {
  const { patchSession } = await import("@/lib/store/sessions")
  const sessions = await listSessions()
  const chat = sessions.find((session) => session.title === "second question")
  assert.ok(chat)
  // Rewrite the ledger away, leaving only the index to speak for this chat.
  writeFileSync(
    join(DATA_DIR, "imports.json"),
    JSON.stringify({ version: 1, entries: [] })
  )
  await patchSession(chat.id, { providerId: "claudeCode" })

  const result = await importConversations({
    provider: "claude-code",
    cwds: [WORKSPACE],
  })
  assert.equal(result.skipped, 2, "both are already in the index")
  assert.equal(result.imported, 0)
})
