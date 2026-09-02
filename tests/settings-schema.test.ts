import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DEFAULT_MEMORY_BUDGET,
  DEFAULT_SETTINGS,
  MAX_RECENT_FOLDERS,
  MEMORY_BUDGET_RANGE,
  normalizeSettings,
} from "@/lib/settings/schema"

/**
 * `settings.json` is written by every version of the app and read by the next
 * one, so normalisation is a compatibility layer, not validation: an old file,
 * a partial file and a corrupt one all have to come back as a complete
 * `AppSettings` rather than throwing on the way to the first render.
 */

test("nothing at all is the defaults", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings("not an object"), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS)
})

test("a partial section keeps its siblings' defaults", () => {
  const settings = normalizeSettings({ providers: { ollama: { baseUrl: "http://box:1234" } } })
  assert.equal(settings.providers.ollama.baseUrl, "http://box:1234")
  assert.equal(
    settings.providers.ollama.enabled,
    DEFAULT_SETTINGS.providers.ollama.enabled
  )
  assert.deepEqual(settings.providers.cursorAgent, DEFAULT_SETTINGS.providers.cursorAgent)
  assert.deepEqual(settings.chat, DEFAULT_SETTINGS.chat)
})

test("a file written before a section existed gains it", () => {
  // The shape a pre-0.2 file has: appearance with a since-dropped `radius`,
  // no providers.acp, no memory, no handoff, no model providers.
  const settings = normalizeSettings({
    appearance: { theme: "notebook", mode: "dark", radius: 0.75 },
    providers: { active: "cursor", ollama: { enabled: false, baseUrl: "http://x" } },
  })
  assert.equal(settings.appearance.theme, "notebook")
  assert.equal(settings.appearance.mode, "dark")
  // `radius` is gone on purpose — the theme gets its own rounding back.
  assert.equal(settings.appearance.radiusOverride, null)
  assert.deepEqual(settings.providers.acp.agents.dsh, DEFAULT_SETTINGS.providers.acp.agents.dsh)
  assert.deepEqual(settings.memory, DEFAULT_SETTINGS.memory)
  assert.deepEqual(settings.handoff, DEFAULT_SETTINGS.handoff)
  assert.deepEqual(settings.modelProviders, DEFAULT_SETTINGS.modelProviders)
})

test("a value of the wrong type falls back rather than reaching the UI", () => {
  const settings = normalizeSettings({
    appearance: { theme: 7, mode: "sideways", contrast: "extreme", radiusOverride: "big" },
    files: { anyPath: "yes" },
    editor: { defaultEditor: 3 },
    recentFolders: "not a list",
  })
  assert.deepEqual(settings.appearance, DEFAULT_SETTINGS.appearance)
  assert.deepEqual(settings.editor, DEFAULT_SETTINGS.editor)
  assert.deepEqual(settings.recentFolders, [])
  // `anyPath` is on unless it is exactly `false` — a garbled value must not
  // quietly narrow the file routes.
  assert.equal(settings.files.anyPath, true)
})

test("the two default-on switches only turn off on a real false", () => {
  assert.equal(normalizeSettings({ files: { anyPath: false } }).files.anyPath, false)
  assert.equal(normalizeSettings({ handoff: { enabled: false } }).handoff.enabled, false)
  assert.equal(normalizeSettings({ handoff: { enabled: "no" } }).handoff.enabled, true)
  // Memory is the opposite: off unless it is exactly `true`.
  assert.equal(normalizeSettings({ memory: { enabled: "yes" } }).memory.enabled, false)
  assert.equal(normalizeSettings({ memory: { enabled: true } }).memory.enabled, true)
})

test("the memory budget is clamped into its range", () => {
  assert.equal(normalizeSettings({ memory: { maxChars: 10 } }).memory.maxChars, MEMORY_BUDGET_RANGE.min)
  assert.equal(
    normalizeSettings({ memory: { maxChars: 999_999 } }).memory.maxChars,
    MEMORY_BUDGET_RANGE.max
  )
  assert.equal(normalizeSettings({ memory: {} }).memory.maxChars, DEFAULT_MEMORY_BUDGET)
  assert.equal(
    normalizeSettings({ memory: { maxChars: Number.NaN } }).memory.maxChars,
    DEFAULT_MEMORY_BUDGET
  )
})

test("a user-added ACP agent survives, validated field by field", () => {
  const settings = normalizeSettings({
    providers: {
      acp: {
        agents: {
          mine: { name: "Mine", command: "my-agent", args: ["--acp", 7], permissionMode: "nonsense" },
        },
      },
    },
  })
  assert.equal(settings.providers.acp.agents.mine.command, "my-agent")
  assert.deepEqual(settings.providers.acp.agents.mine.args, ["--acp"])
  assert.equal(settings.providers.acp.agents.mine.permissionMode, "auto-approve")
  // …and the built-in one is still there beside it.
  assert.ok(settings.providers.acp.agents.dsh)
})

test("recent folders are de-duplicated, trimmed and capped", () => {
  const many = Array.from({ length: MAX_RECENT_FOLDERS + 5 }, (_, i) => `/p/${i}`)
  assert.equal(normalizeSettings({ recentFolders: many }).recentFolders.length, MAX_RECENT_FOLDERS)
  assert.deepEqual(
    normalizeSettings({ recentFolders: ["/p/a", " /p/a ", "", 7, "/p/b"] }).recentFolders,
    ["/p/a", "/p/b"]
  )
})

test("normalising twice is the same as normalising once", () => {
  const stored = {
    appearance: { theme: "notebook", mode: "dark" },
    providers: { active: "pi", pi: { workspace: "/home/me/p" } },
    memory: { enabled: true, model: "qwen3:4b", maxChars: 3000 },
    modelProviders: { openai: { enabled: true, apiKey: "k", models: ["gpt-5"] } },
    recentFolders: ["/home/me/p"],
  }
  const once = normalizeSettings(stored)
  assert.deepEqual(normalizeSettings(once), once)
})
