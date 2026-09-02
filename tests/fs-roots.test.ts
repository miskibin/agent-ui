import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

/**
 * The containment rule behind `/api/files` and `POST /api/open`.
 *
 * `files.anyPath` is the switch; `isWithinKnownRoot` is what it switches on,
 * and it is the only thing standing between "show me the chart the agent
 * wrote" and "read me any file on this machine". Every case here is one a
 * hand-made request could try.
 */

// `dataDir()` reads the environment on every call, so this only has to be set
// before the first one — but the store caches its index per process, which is
// why every session below is created through `createSession`.
const DATA_DIR = mkdtempSync(join(tmpdir(), "agent-ui-fs-roots-"))
process.env.AGENT_UI_DIR = DATA_DIR

const { isWithin, isWithinKnownRoot } = await import("@/lib/fs-roots")
const { createSession } = await import("@/lib/store/sessions")
const { normalizeSettings } = await import("@/lib/settings/schema")

const CHAT_DIR = mkdtempSync(join(tmpdir(), "agent-ui-chat-"))
const OUTSIDE_DIR = mkdtempSync(join(tmpdir(), "agent-ui-outside-"))

const settings = normalizeSettings({
  providers: { pi: { workspace: "" }, acp: { agents: {} } },
})

test("isWithin accepts the root itself and everything under it", () => {
  assert.equal(isWithin("/home/me/project", "/home/me/project"), true)
  assert.equal(isWithin("/home/me/project", "/home/me/project/src/app.ts"), true)
  // A trailing separator on the root must not change the answer.
  assert.equal(isWithin("/home/me/project/", "/home/me/project/src"), true)
})

test("isWithin refuses a sibling whose name merely starts with the root", () => {
  assert.equal(isWithin("/home/me/project", "/home/me/project-secrets/keys"), false)
  assert.equal(isWithin("/home/me/project", "/home/me"), false)
  assert.equal(isWithin("/home/me/project", "/etc/passwd"), false)
})

test("isWithin resolves `..` before comparing, so traversal cannot escape", () => {
  assert.equal(isWithin("/home/me/project", "/home/me/project/../../etc/passwd"), false)
  assert.equal(isWithin("/home/me/project", "/home/me/project/src/../src/app.ts"), true)
  // …and cannot be smuggled in as a relative path either.
  assert.equal(isWithin(".", resolve("..")), false)
})

test("a chat's own folder is a known root; an unrelated folder is not", async () => {
  await createSession({
    title: "Pinned to a folder",
    providerId: "mock",
    model: "",
    cwd: CHAT_DIR,
  })

  assert.equal(await isWithinKnownRoot(join(CHAT_DIR, "chart.png"), settings), true)
  assert.equal(
    await isWithinKnownRoot(join(OUTSIDE_DIR, "chart.png"), settings),
    false
  )
  assert.equal(await isWithinKnownRoot("/etc/passwd", settings), false)
})

test("traversal out of a chat folder is not a known root", async () => {
  assert.equal(
    await isWithinKnownRoot(join(CHAT_DIR, "..", "..", "etc", "passwd"), settings),
    false
  )
})

test("a provider workspace named in settings is a known root", async () => {
  const withWorkspace = normalizeSettings({
    providers: { pi: { workspace: OUTSIDE_DIR }, acp: { agents: {} } },
  })
  assert.equal(
    await isWithinKnownRoot(join(OUTSIDE_DIR, "notes.md"), withWorkspace),
    true
  )
  // An empty workspace string must never widen the check to "/".
  const noWorkspace = normalizeSettings({
    providers: { pi: { workspace: "   " }, acp: { agents: { dsh: { workspace: "" } } } },
  })
  assert.equal(await isWithinKnownRoot("/", noWorkspace), false)
})

test("the app's own data directory counts as one of its folders", async () => {
  // `/api/files` reads it as an app folder; `POST /api/open` refuses it up
  // front — one check cannot stand in for the other, and the open route's
  // extra refusal is asserted over HTTP in tests/e2e.
  assert.equal(await isWithinKnownRoot(join(DATA_DIR, "settings.json"), settings), true)
  assert.equal(isWithin(DATA_DIR, join(DATA_DIR, "settings.json")), true)
})
