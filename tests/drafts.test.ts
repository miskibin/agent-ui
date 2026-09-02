import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

/**
 * Composer state that has to survive a chat switch and a reload. It is a
 * convenience, so every path through it must also survive a `localStorage`
 * that refuses to answer — a private window, a full quota — without throwing
 * into the composer.
 */

type Store = { get: (key: string) => string | null; set: (key: string, value: string) => void }

let backing = new Map<string, string>()
let store: Store = {
  get: (key) => backing.get(key) ?? null,
  set: (key, value) => void backing.set(key, value),
}

// `lib/drafts` reads `window.localStorage` on every call, so one stand-in
// installed before the import serves the whole suite.
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => store.get(key),
    setItem: (key: string, value: string) => store.set(key, value),
  },
}

const { clearDraft, readDrafts, readStash, writeDraft, writeStash } = await import(
  "@/lib/drafts"
)

beforeEach(() => {
  backing = new Map()
  store = {
    get: (key) => backing.get(key) ?? null,
    set: (key, value) => void backing.set(key, value),
  }
})

test("a draft is written per chat and read back", () => {
  writeDraft("s1", "half a thought")
  writeDraft("s2", "another")
  assert.deepEqual(readDrafts(), { s1: "half a thought", s2: "another" })
})

test("emptying a draft removes it rather than storing blank text", () => {
  writeDraft("s1", "text")
  writeDraft("s1", "   ")
  assert.deepEqual(readDrafts(), {})
  // A chat with no id has nowhere to file a draft.
  writeDraft("", "text")
  assert.deepEqual(readDrafts(), {})
})

test("a deleted chat's draft is dropped", () => {
  writeDraft("s1", "text")
  clearDraft("s1")
  clearDraft("s1")
  assert.deepEqual(readDrafts(), {})
})

test("a very long draft is capped before it is stored", () => {
  writeDraft("s1", "x".repeat(30_000))
  assert.equal(readDrafts().s1.length, 20_000)
})

test("junk in storage reads as no drafts, not as a crash", () => {
  backing.set("agent-ui:drafts", "{not json")
  assert.deepEqual(readDrafts(), {})
  backing.set("agent-ui:drafts", "[1,2]")
  assert.deepEqual(readDrafts(), {})
})

test("storage that throws is survivable in both directions", () => {
  store = {
    get: () => {
      throw new Error("private mode")
    },
    set: () => {
      throw new Error("quota")
    },
  }
  assert.deepEqual(readDrafts(), {})
  assert.doesNotThrow(() => writeDraft("s1", "text"))
  assert.doesNotThrow(() => readStash())
})

test("the stash keeps text and file names, never the File objects", () => {
  writeStash([
    {
      id: "a",
      text: "parked",
      createdAt: 5,
      fileNames: ["notes.md"],
      files: [{ name: "notes.md" } as unknown as File],
      skills: ["review"],
    },
  ])
  const [entry] = readStash()
  assert.deepEqual(entry, {
    id: "a",
    text: "parked",
    createdAt: 5,
    fileNames: ["notes.md"],
    skills: ["review"],
  })
  assert.equal("files" in entry, false)
})

test("the stash is capped and malformed entries are dropped", () => {
  writeStash(
    Array.from({ length: 25 }, (_, index) => ({
      id: `s${index}`,
      text: `${index}`,
      createdAt: index,
      fileNames: [],
      skills: [],
    }))
  )
  assert.equal(readStash().length, 20)

  backing.set(
    "agent-ui:stash",
    JSON.stringify([{ id: "ok", text: "t" }, { text: "no id" }, null, 7])
  )
  assert.deepEqual(readStash(), [
    { id: "ok", text: "t", createdAt: 0, fileNames: [], skills: [] },
  ])
})
