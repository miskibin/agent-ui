import assert from "node:assert/strict"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

/**
 * The JSON store under `$AGENT_UI_DIR`. A session id ends up in a file path,
 * which is why it is validated against a known-safe alphabet rather than
 * escaped — the check below is the one standing between a request-supplied id
 * and `sessions/<id>.json`.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), "agent-ui-store-"))
process.env.AGENT_UI_DIR = DATA_DIR

const {
  createSession,
  deleteSession,
  isValidSessionId,
  listSessions,
  newSessionId,
  patchSession,
  readJournal,
  readMessages,
  writeMessages,
} = await import("@/lib/store/sessions")

test("an id is letters, digits, dash and underscore, and nothing else", () => {
  for (const ok of ["a", "s1", "A-b_c", "s".padEnd(64, "x")]) {
    assert.equal(isValidSessionId(ok), true, ok)
  }
  for (const bad of [
    "",
    "s".padEnd(65, "x"),
    "../../etc/passwd",
    "a/b",
    "a\\b",
    "a.json",
    "a b",
    "a\0b",
    "sesja-ąę",
    "a:b",
  ]) {
    assert.equal(isValidSessionId(bad), false, JSON.stringify(bad))
  }
})

test("a minted id is one the validator accepts", () => {
  for (let i = 0; i < 50; i += 1) {
    assert.equal(isValidSessionId(newSessionId()), true)
  }
})

test("a path-shaped id reaches neither the transcript nor the journal", async () => {
  const escape = "../../settings"
  assert.deepEqual(await readMessages(escape), [])
  assert.deepEqual(await readJournal(escape), [])
  assert.equal(await writeMessages(escape, [{ id: "m", content: "x", sender: "user" }]), null)
  assert.equal(existsSync(join(DATA_DIR, "settings.json")), false)
})

test("a chat round-trips through the index and its own file", async () => {
  const session = await createSession({
    title: "  Fix the build  ",
    providerId: "mock",
    model: "composer-2.5",
    cwd: " /home/me/project ",
  })
  assert.equal(session.title, "Fix the build")
  assert.equal(session.cwd, "/home/me/project")
  assert.equal(session.messageCount, 0)

  await writeMessages(session.id, [
    { id: "u1", content: "hi", sender: "user" },
    { id: "a1", content: "hello", sender: "assistant" },
  ])
  const messages = await readMessages(session.id)
  assert.deepEqual(messages.map((message) => message.id), ["u1", "a1"])

  const [stored] = (await listSessions()).filter((entry) => entry.id === session.id)
  assert.equal(stored.messageCount, 2)
  assert.ok(existsSync(join(DATA_DIR, "sessions", `${session.id}.json`)))
})

test("the newest chat is first and `order` stays dense", async () => {
  const first = await createSession({ title: "first" })
  const second = await createSession({ title: "second" })
  const sessions = await listSessions()
  assert.equal(sessions[0].id, second.id)
  assert.deepEqual(
    sessions.map((entry) => entry.order),
    sessions.map((_, index) => index)
  )
  assert.ok(sessions.some((entry) => entry.id === first.id))
})

test("patching a chat's order moves the row and renumbers the list", async () => {
  const sessions = await listSessions()
  const last = sessions[sessions.length - 1]
  await patchSession(last.id, { order: 0, pinned: true })
  const after = await listSessions()
  assert.equal(after[0].id, last.id)
  assert.equal(after[0].pinned, true)
  assert.deepEqual(
    after.map((entry) => entry.order),
    after.map((_, index) => index)
  )
})

test("deleting a chat takes its transcript with it", async () => {
  const session = await createSession({ title: "temporary" })
  await writeMessages(session.id, [{ id: "u1", content: "hi", sender: "user" }])
  const file = join(DATA_DIR, "sessions", `${session.id}.json`)
  assert.ok(existsSync(file))

  assert.equal(await deleteSession(session.id), true)
  assert.equal(existsSync(file), false)
  assert.equal(await deleteSession(session.id), false)
  assert.equal(
    (await listSessions()).some((entry) => entry.id === session.id),
    false
  )
})
