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
  appendJournal,
  readJournal,
  readMessages,
  upsertMessages,
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

test("a turn's write merges by id instead of replaying what it read", async () => {
  const session = await createSession({ title: "concurrent" })
  await writeMessages(session.id, [
    { id: "u1", content: "first", sender: "user" },
    { id: "a1", content: "answered", sender: "assistant" },
  ])

  // What a streaming turn holds: the transcript as it stood when it started.
  const prior = await readMessages(session.id)
  // …while it streams, the user edits an earlier message and deletes a turn.
  await writeMessages(session.id, [{ id: "u1", content: "first, edited", sender: "user" }])
  // …and the turn settles, writing only the two rows it owns.
  await upsertMessages(session.id, [
    { id: "u2", content: "second", sender: "user" },
    { id: "a2", content: "answer", sender: "assistant" },
  ])

  assert.deepEqual(prior.map((message) => message.id), ["u1", "a1"])
  const after = await readMessages(session.id)
  assert.deepEqual(after.map((message) => message.id), ["u1", "u2", "a2"])
  assert.equal(after[0].content, "first, edited")
  const [stored] = (await listSessions()).filter((entry) => entry.id === session.id)
  assert.equal(stored.messageCount, 3)
})

test("an upserted row replaces the one already stored, in place", async () => {
  const session = await createSession({ title: "seeded then finished" })
  await upsertMessages(session.id, [{ id: "u1", content: "hi", sender: "user" }])
  await upsertMessages(session.id, [
    { id: "u1", content: "hi", sender: "user", createdAt: 7 },
    { id: "a1", content: "hello", sender: "assistant" },
  ])
  const messages = await readMessages(session.id)
  assert.deepEqual(messages.map((message) => message.id), ["u1", "a1"])
  assert.equal(messages[0].createdAt, 7)
})

test("a chat deleted mid-turn is not re-created by the write that lands after", async () => {
  const session = await createSession({ title: "deleted while streaming" })
  await writeMessages(session.id, [{ id: "u1", content: "hi", sender: "user" }])
  assert.equal(await deleteSession(session.id), true)

  assert.equal(
    await upsertMessages(session.id, [{ id: "a1", content: "late", sender: "assistant" }]),
    null
  )
  assert.deepEqual(
    await appendJournal(session.id, [
      { kind: "turn-end", providerId: "mock", model: "", outcome: "ok" },
    ]),
    []
  )
  assert.equal(existsSync(join(DATA_DIR, "sessions", `${session.id}.json`)), false)
  assert.equal(
    existsSync(join(DATA_DIR, "sessions", `${session.id}.journal.json`)),
    false
  )
})
