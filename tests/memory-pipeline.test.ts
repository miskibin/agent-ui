import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { buildMemoryContext } from "@/lib/memory/context"
import { renderMemoryContext } from "@/lib/memory/prompt"
import {
  deleteMemoryFile,
  readMemoryFiles,
  writeMemoryFile,
} from "@/lib/memory/server"
import { callMemoryTool, type MemoryTools } from "@/lib/memory/tools"
import {
  MAX_MEMORY_FILE_CHARS,
  MAX_MEMORY_FILES,
  parseMemoryFile,
  serializeMemoryFile,
  type MemoryFile,
} from "@/lib/memory/types"
import { handleRpc, type SubagentTools } from "@/lib/subagents/mcp"
import { DEFAULT_SETTINGS, type AppSettings } from "@/lib/settings/schema"

/*
 * Agent-kept memory: real files under a temp AGENT_UI_DIR, the MCP tools the
 * agent writes through, and the block a turn is handed. What it pins is the
 * shape that keeps memory small — one file per topic, updates in place, a hard
 * cap that tells the agent to merge — and that nothing here needs a model.
 */

let dir = ""

test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-ui-memory-"))
  process.env.AGENT_UI_DIR = dir
})

test.after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test.beforeEach(async () => {
  await rm(join(dir, "memory"), { recursive: true, force: true })
})

const tools: MemoryTools = {
  list: readMemoryFiles,
  write: writeMemoryFile,
  remove: deleteMemoryFile,
}

function settings(memory: Partial<AppSettings["memory"]>): AppSettings {
  return { ...DEFAULT_SETTINGS, memory: { ...DEFAULT_SETTINGS.memory, ...memory } }
}

function file(name: string, content: string, description = `${name} notes`): MemoryFile {
  return { name, description, content, updatedAt: 0, bytes: content.length }
}

test("a file round-trips through its frontmatter, and an old-style file still reads", () => {
  const raw = serializeMemoryFile("How answers should look", "- Prefers concise answers")
  assert.deepEqual(parseMemoryFile("preferences", raw), {
    description: "How answers should look",
    content: "- Prefers concise answers",
  })
  // What the Ollama extractor left behind: a heading and bullets.
  assert.deepEqual(parseMemoryFile("stack", "# Stack\n\n- Uses pnpm\n"), {
    description: "Stack",
    content: "# Stack\n\n- Uses pnpm",
  })
})

test("memory_write creates, then updates the same file in place", async () => {
  const created = await callMemoryTool(tools, "memory_write", {
    name: "Preferences",
    description: "How answers should be written",
    content: "- Prefers concise answers",
  })
  assert.deepEqual(created.data, { name: "preferences", status: "created" })

  const updated = await callMemoryTool(tools, "memory_write", {
    name: "preferences",
    description: "How answers should be written",
    content: "- Prefers concise answers\n- Answers in Polish",
  })
  assert.deepEqual(updated.data, { name: "preferences", status: "updated" })

  const files = await readMemoryFiles()
  assert.equal(files.length, 1)
  assert.match(files[0].content, /Answers in Polish/)
  const raw = await readFile(join(dir, "memory", "preferences.md"), "utf8")
  assert.match(raw, /^---\ndescription: How answers should be written\n---\n/)
})

test("past the file cap a new file is refused with the names to merge into", async () => {
  for (let index = 0; index < MAX_MEMORY_FILES; index++) {
    await writeMemoryFile({ name: `topic-${index}`, description: "d", content: "- x" })
  }
  const refused = await callMemoryTool(tools, "memory_write", {
    name: "one-more",
    description: "d",
    content: "- y",
  })
  assert.equal(refused.isError, true)
  assert.match(String(refused.data), /topic-0/)
  assert.match(String(refused.data), /instead of creating a new one/)

  // Updating one that exists is still fine at the cap.
  const update = await callMemoryTool(tools, "memory_write", {
    name: "topic-0",
    description: "d",
    content: "- z",
  })
  assert.equal(update.isError, undefined)
})

test("an oversized file and a missing description are refused", async () => {
  const big = await callMemoryTool(tools, "memory_write", {
    name: "stack",
    description: "d",
    content: "x".repeat(MAX_MEMORY_FILE_CHARS + 1),
  })
  assert.equal(big.isError, true)
  assert.match(String(big.data), /Condense it/)

  const bare = await callMemoryTool(tools, "memory_write", { name: "stack", content: "- x" })
  assert.equal(bare.isError, true)
  assert.equal((await readMemoryFiles()).length, 0)
})

test("memory_delete removes a file and says so when there was none", async () => {
  await writeMemoryFile({ name: "stack", description: "d", content: "- Uses pnpm" })
  assert.deepEqual((await callMemoryTool(tools, "memory_delete", { name: "stack" })).data, {
    name: "stack",
    status: "deleted",
  })
  assert.equal((await callMemoryTool(tools, "memory_delete", { name: "stack" })).isError, true)
})

test("memory_read lists the index without a name, and refuses a path", async () => {
  await writeMemoryFile({ name: "stack", description: "Tools in use", content: "- Uses pnpm" })
  const index = await callMemoryTool(tools, "memory_read", {})
  assert.deepEqual((index.data as { files: unknown[] }).files, [
    { name: "stack", description: "Tools in use" },
  ])
  // `../settings` slugs to `settings`, which does not exist — never a path.
  const escape = await callMemoryTool(tools, "memory_read", { name: "../settings" })
  assert.equal(escape.isError, true)
})

test("the MCP server offers memory tools only while memory is on", async () => {
  const subagents = {} as SubagentTools
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" }
  const names = async (memory?: MemoryTools) => {
    const answer = (await handleRpc(list, subagents, "0", memory)) as {
      result: { tools: { name: string }[] }
    }
    return answer.result.tools.map((tool) => tool.name)
  }
  assert.ok(!(await names()).includes("memory_write"))
  assert.ok((await names(tools)).includes("memory_write"))

  const call = (await handleRpc(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_write", arguments: {} } },
    subagents,
    "0"
  )) as { result: { isError?: boolean; content: { text: string }[] } }
  assert.equal(call.result.isError, true)
  assert.match(call.result.content[0].text, /turned off/)
})

test("an agent with tools is told how to keep memory; a chat-only one is not", () => {
  const files = [file("preferences", "- Prefers concise answers")]
  const withTools = renderMemoryContext({ files, budget: 1000, access: "tools", dir: "/m" })!
  assert.match(withTools, /Prefers concise answers/)
  assert.match(withTools, /memory_write/)
  assert.match(withTools, /update that file instead/)

  const chatOnly = renderMemoryContext({ files, budget: 1000, access: "none", dir: "/m" })!
  assert.match(chatOnly, /Prefers concise answers/)
  assert.doesNotMatch(chatOnly, /Keeping memory/)

  const viaFiles = renderMemoryContext({ files, budget: 1000, access: "files", dir: "/m" })!
  assert.match(viaFiles, /editing the files in \/m/)
})

test("an empty store still invites an agent with tools, and sends nothing to one without", () => {
  assert.equal(renderMemoryContext({ files: [], budget: 1000, access: "none", dir: "/m" }), undefined)
  assert.match(
    renderMemoryContext({ files: [], budget: 1000, access: "tools", dir: "/m" })!,
    /nothing remembered yet/
  )
})

test("past the budget, bodies are left out but every file stays in the index", () => {
  const block = renderMemoryContext({
    files: [
      file("stack", "- " + "a".repeat(300)),
      file("preferences", "- Prefers concise answers"),
    ],
    budget: 100,
    access: "tools",
    dir: "/m",
  })!
  assert.match(block, /Prefers concise answers/)
  assert.match(block, /`stack` — stack notes \(updated .*; not loaded\)/)
  assert.match(block, /One file is not loaded/)
})

test("buildMemoryContext reads the files and is off when memory is", async () => {
  await mkdir(join(dir, "memory"), { recursive: true })
  await writeFile(join(dir, "memory", "stack.md"), "# Stack\n\n- Uses pnpm\n")
  assert.equal(await buildMemoryContext(settings({ enabled: false }), { access: "tools" }), undefined)
  const block = await buildMemoryContext(settings({ enabled: true }), { access: "files" })
  assert.match(block!, /Uses pnpm/)
})
