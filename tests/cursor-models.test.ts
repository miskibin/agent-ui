import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"

import { createCursorProvider, parseCursorAcpModels } from "@/lib/providers/cursor"

/**
 * Cursor's CLI publishes its real model list over its own ACP extension
 * method, which answers straight off the handshake — no session, no turn. The
 * scrape of `agent models` stays as the fallback, and the two produce very
 * different lists: the extension's is the curated one Cursor's own picker
 * shows, the scrape's is dozens of aliases that `HEADLINE_IDS` has to cut down.
 */

test("the extension response is read into id/name pairs", () => {
  assert.deepEqual(
    parseCursorAcpModels({
      models: [
        { value: "composer-2.5", name: "Composer 2.5" },
        { value: " gpt-5.6-sol-high ", name: " GPT-5.6 Sol " },
      ],
    }),
    [
      { id: "composer-2.5", name: "Composer 2.5" },
      { id: "gpt-5.6-sol-high", name: "GPT-5.6 Sol" },
    ]
  )
})

test("entries with nothing usable, and repeats, are dropped", () => {
  assert.deepEqual(
    parseCursorAcpModels({
      models: [
        { value: "", name: "Nameless" },
        { value: "auto" },
        { name: "No id" },
        null,
        "auto",
        { value: "auto", name: "Auto" },
        { value: "auto", name: "Auto again" },
      ],
    }),
    [{ id: "auto", name: "Auto" }]
  )
})

test("a response of any other shape lists nothing rather than throwing", () => {
  assert.deepEqual(parseCursorAcpModels(undefined), [])
  assert.deepEqual(parseCursorAcpModels({}), [])
  assert.deepEqual(parseCursorAcpModels({ models: "auto" }), [])
  assert.deepEqual(parseCursorAcpModels("auto"), [])
})

/* -------------------------------------------------------------------------- */

/**
 * The live half. It is skipped for the same reason `tests/acp-stream.test.ts`
 * is: `listModels` reaches the ACP client, which imports values out of
 * `lib/acp-types.ts` — syntax the strip-only loader behind `npm run test`
 * cannot parse.
 */
let acpLoadable = true
try {
  await import("@/lib/acp-agent")
} catch {
  acpLoadable = false
}
const unloadable = "lib/acp-types.ts is unparseable by the strip-only loader"

const scratch = mkdtempSync(path.join(tmpdir(), "agent-ui-cursor-models-"))
const fakeAgent = path.join(scratch, "fake-cursor-agent.js")

/** Answers `initialize` and the one extension method, and nothing else. */
writeFileSync(
  fakeAgent,
  `
if (process.argv[2] !== "acp") process.exit(1)
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })
    } else if (message.method === "cursor/list_available_models") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { models: [
          { value: "composer-2.5", name: "Composer 2.5" },
          { value: "claude-opus-5-thinking-high", name: "Opus 5 Thinking" },
          { value: "a-model-added-yesterday", name: "Brand New" },
        ] },
      })
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } })
    }
  }
})
setTimeout(() => {}, 30000)
`
)

/** Refuses `acp`, so the provider has to fall back to scraping `agent models`. */
const scrapeOnlyAgent = path.join(scratch, "scrape-only-agent")
writeFileSync(
  scrapeOnlyAgent,
  `#!${process.execPath}\n` +
    `if (process.argv[2] !== "models") process.exit(1)\n` +
    `process.stdout.write([\n` +
    `  "composer-2.5 - Composer 2.5 (fast)",\n` +
    `  "claude-opus-5-thinking-high - Opus 5 Thinking",\n` +
    `  "some-internal-alias-1 - Internal alias",\n` +
    `].join("\\n") + "\\n")\n`,
  { mode: 0o755 }
)

const inheritedBin = process.env.CURSOR_AGENT_BIN

after(() => {
  if (inheritedBin === undefined) delete process.env.CURSOR_AGENT_BIN
  else process.env.CURSOR_AGENT_BIN = inheritedBin
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* housekeeping only */
  }
})

test(
  "the curated list is taken whole, not filtered down to the headline ids",
  { skip: !acpLoadable && unloadable },
  async () => {
    process.env.CURSOR_AGENT_BIN = fakeAgent
    const provider = createCursorProvider({ enabled: true, binPath: fakeAgent })
    const models = await provider.listModels!()
    assert.deepEqual(
      models.map((model) => model.id),
      ["composer-2.5", "claude-opus-5-thinking-high", "a-model-added-yesterday"],
      "a model Cursor added since HEADLINE_IDS was written still shows up"
    )
    assert.equal(models[0].badge, "Cursor")
    assert.equal(models[1].badge, "Anthropic")
  }
)

test("a CLI without the extension falls back to the scrape and its headline ids", async () => {
  process.env.CURSOR_AGENT_BIN = scrapeOnlyAgent
  const provider = createCursorProvider({ enabled: true, binPath: scrapeOnlyAgent })
  const models = await provider.listModels!()
  assert.deepEqual(
    models.map((model) => model.id),
    ["composer-2.5", "claude-opus-5-thinking-high"],
    "the alias the scrape also lists is not offered"
  )
  assert.equal(models[0].name, "Composer 2.5", "and the parenthetical is trimmed")
})
