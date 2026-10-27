import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { buildMemoryContext } from "@/lib/memory/context"
import { extractMemory } from "@/lib/memory/extract"
import { DEFAULT_SETTINGS, type AppSettings } from "@/lib/settings/schema"

/*
 * The memory pipeline against a fake Ollama: real HTTP, real files, a
 * deterministic "embedding" (one axis per topic word) and a scripted
 * extractor. What it pins is the wiring — operations applied, restatements
 * dropped by the embedder, the prompt ranked, and nothing at all when Ollama
 * is gone.
 */

const TOPICS = ["pnpm", "typescript", "chess", "vercel", "concise"]

function embedding(text: string) {
  const lower = text.toLowerCase()
  const vector: number[] = TOPICS.map((topic) => (lower.includes(topic) ? 1 : 0))
  vector.push(0.05) // never the zero vector
  return vector
}

let operations: unknown[] = []
let embedCalls = 0
let server: Server
let baseUrl = ""
let dir = ""

test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-ui-memory-"))
  process.env.AGENT_UI_DIR = dir
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json")
      if (req.url === "/api/tags") {
        res.end(JSON.stringify({ models: [{ name: "embeddinggemma-2:270m" }] }))
      } else if (req.url === "/api/embed") {
        embedCalls++
        const { input, dimensions } = JSON.parse(body) as {
          input: string[]
          dimensions?: number
        }
        assert.equal(dimensions, 256)
        res.end(JSON.stringify({ embeddings: input.map(embedding) }))
      } else if (req.url === "/api/chat") {
        res.end(JSON.stringify({ message: { content: JSON.stringify({ operations }) } }))
      } else {
        res.statusCode = 404
        res.end("{}")
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.after(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

function settings(patch: Partial<AppSettings["memory"]> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    providers: {
      ...DEFAULT_SETTINGS.providers,
      ollama: { ...DEFAULT_SETTINGS.providers.ollama, baseUrl },
    },
    memory: { ...DEFAULT_SETTINGS.memory, enabled: true, model: "qwen3:4b", ...patch },
  }
}

test("extraction applies operations and drops a restated fact", async () => {
  await mkdir(join(dir, "memory"), { recursive: true })
  await writeFile(
    join(dir, "memory", "stack.md"),
    "# Stack\n\n- Uses pnpm\n- Plays chess on weekends\n"
  )
  operations = [
    { op: "add", category: "stack", text: "Prefers pnpm over npm" }, // restates f1
    { op: "add", category: "stack", text: "Writes TypeScript" },
    { op: "delete", id: "f2" },
    { op: "add", category: "nonsense", text: "Should be refused" },
  ]
  const result = await extractMemory({
    settings: settings().memory,
    baseUrl,
    userMessages: ["I use pnpm and typescript, and I gave up chess"],
  })
  assert.equal(result.ranking, "embedding")
  assert.deepEqual(result.changes, [
    {
      category: "stack",
      added: ["- Writes TypeScript"],
      removed: ["- Plays chess on weekends"],
    },
  ])
  assert.equal(
    await readFile(join(dir, "memory", "stack.md"), "utf8"),
    "# Stack\n\n- Uses pnpm\n- Writes TypeScript\n"
  )
  // The cache was warmed for the next turn.
  const cache = JSON.parse(await readFile(join(dir, "memory", ".vectors.json"), "utf8"))
  assert.deepEqual(Object.keys(cache.vectors).sort(), ["uses pnpm", "writes typescript"])
})

test("a store past the budget is ranked against the prompt", async () => {
  await writeFile(
    join(dir, "memory", "preferences.md"),
    "# Preferences\n\n- Prefers concise answers\n"
  )
  await writeFile(
    join(dir, "memory", "workflow.md"),
    "# Workflow\n\n- Deploys every project to Vercel from the main branch\n"
  )
  const before = embedCalls
  const block = await buildMemoryContext(settings({ maxChars: 60 }), {
    toolCapable: true,
    query: "how should I set up the typescript config?",
  })
  assert.ok(block)
  assert.match(block, /Prefers concise answers/)
  assert.match(block, /Writes TypeScript/)
  assert.doesNotMatch(block, /Vercel/)
  assert.match(block, /more facts are stored there/)
  // Only the query and the two never-seen facts were embedded.
  assert.equal(embedCalls - before, 2)
})

test("a store that fits is sent whole, with no embedding at all", async () => {
  const before = embedCalls
  const block = await buildMemoryContext(settings(), { toolCapable: false, query: "hi" })
  assert.ok(block)
  assert.match(block, /Vercel/)
  assert.equal(embedCalls, before)
})

test("without Ollama, memory is off: nothing injected, nothing extracted", async () => {
  const down = settings()
  down.providers = {
    ...down.providers,
    // A remote URL is probed but never spawned for, so the test cannot start one.
    ollama: { ...down.providers.ollama, baseUrl: "http://192.0.2.1:9" },
  }
  assert.equal(await buildMemoryContext(down, { toolCapable: true, query: "pnpm" }), undefined)
  const result = await extractMemory({
    settings: down.memory,
    baseUrl: undefined,
    userMessages: ["I use pnpm"],
  })
  assert.equal(result.skipped, "unreachable")
})
