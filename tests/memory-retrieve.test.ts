import assert from "node:assert/strict"
import test from "node:test"

import {
  documentInput,
  factKey,
  factsFromFiles,
  findDuplicate,
  lexicalScores,
  queryInput,
  renderFacts,
  selectMemory,
  similarity,
  toUnitVector,
  type MemoryFact,
} from "@/lib/memory/retrieve"
import type { MemoryFile } from "@/lib/memory/types"

function file(category: string, title: string, lines: string[]): MemoryFile {
  const content = `# ${title}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`
  return { category, title, content, updatedAt: 0, bytes: content.length }
}

function fact(category: string, text: string): MemoryFact {
  return { key: factKey(text), category, title: category, text }
}

test("facts come out of the files deduplicated, without headings or empty bullets", () => {
  const facts = factsFromFiles([
    file("preferences", "Preferences", ["Prefers concise answers", "Writes in English"]),
    {
      ...file("stack", "Stack", ["Uses pnpm"]),
      content: "# Stack\n\n- Uses pnpm\n- \n- prefers concise answers.\n",
    },
  ])
  assert.deepEqual(
    facts.map((entry) => `${entry.category}:${entry.text}`),
    ["preferences:Prefers concise answers", "preferences:Writes in English", "stack:Uses pnpm"]
  )
})

test("EmbeddingGemma's task prompts are put on both sides", () => {
  assert.equal(queryInput("pnpm?"), "task: search result | query: pnpm?")
  assert.equal(documentInput("Uses pnpm"), "title: none | text: Uses pnpm")
})

test("vectors are cut to the Matryoshka prefix and made unit length", () => {
  const vector = toUnitVector([3, 4, 12, 99], 2)
  assert.equal(vector.length, 2)
  assert.ok(Math.abs(vector[0] - 0.6) < 1e-6)
  assert.ok(Math.abs(similarity(vector, vector) - 1) < 1e-6)
})

test("a store that fits is sent whole, unranked", () => {
  const facts = [fact("stack", "Uses pnpm"), fact("profile", "Lives in Wrocław")]
  const selection = selectMemory({ facts, budget: 1_000, scores: new Map() })
  assert.equal(selection.ranked, false)
  assert.equal(selection.facts.length, 2)
})

test("past the budget, preferences stay and the rest go by relevance", () => {
  const facts = [
    fact("preferences", "Prefers concise answers"),
    fact("stack", "Uses pnpm for every JavaScript project"),
    fact("profile", "Plays chess on weekends with friends"),
    fact("workflow", "Runs the test suite before every single commit"),
  ]
  const scores = new Map([
    [facts[1].key, 0.8],
    [facts[2].key, 0.1],
    [facts[3].key, 0.5],
  ])
  const budget = facts[0].text.length + facts[1].text.length + facts[3].text.length + 9
  const selection = selectMemory({ facts, budget, scores, minScore: 0 })
  assert.equal(selection.ranked, true)
  assert.deepEqual(
    selection.facts.map((entry) => entry.category),
    ["preferences", "stack", "workflow"]
  )
  assert.equal(selection.omitted, 1)
})

test("MMR skips a near-twin of a fact already picked", () => {
  const facts = [
    fact("stack", "Uses TypeScript everywhere"),
    fact("stack", "Writes all code in TypeScript"),
    fact("workflow", "Deploys to Vercel from main"),
  ]
  const vectors = new Map<string, Float32Array>([
    [facts[0].key, toUnitVector([1, 0, 0], 3)],
    [facts[1].key, toUnitVector([0.99, 0.05, 0], 3)],
    [facts[2].key, toUnitVector([0, 1, 0], 3)],
  ])
  const scores = new Map([
    [facts[0].key, 0.9],
    [facts[1].key, 0.88],
    [facts[2].key, 0.6],
  ])
  // Room for two of the three.
  const budget = facts[0].text.length + facts[2].text.length + 6
  const selection = selectMemory({ facts, budget, scores, vectors })
  assert.deepEqual(
    selection.facts.map((entry) => entry.text),
    ["Uses TypeScript everywhere", "Deploys to Vercel from main"]
  )
})

test("facts below the relevance floor are not sent just because there is room", () => {
  const facts = [fact("profile", "x".repeat(80)), fact("stack", "Uses pnpm")]
  const vectors = new Map([
    [facts[0].key, toUnitVector([1, 0], 2)],
    [facts[1].key, toUnitVector([0, 1], 2)],
  ])
  const scores = new Map([
    [facts[0].key, 0.1],
    [facts[1].key, 0.7],
  ])
  const selection = selectMemory({ facts, budget: 60, scores, vectors })
  assert.deepEqual(selection.facts.map((entry) => entry.text), ["Uses pnpm"])
})

test("lexical scores favour the fact that shares the prompt's words", () => {
  const facts = [
    fact("stack", "Uses pnpm as the package manager"),
    fact("profile", "Works at a railway company"),
  ]
  const scores = lexicalScores("which package manager should I install with?", facts)
  assert.equal(scores.get(facts[0].key), 1)
  assert.equal(scores.has(facts[1].key), false)
})

test("a duplicate is found by key, by embedding, and lexically without one", () => {
  const facts = [fact("stack", "Uses pnpm"), fact("profile", "Lives in Wrocław, Poland")]
  assert.equal(findDuplicate("uses pnpm.", facts), facts[0])

  const vectors = new Map([[facts[0].key, toUnitVector([1, 0], 2)]])
  assert.equal(
    findDuplicate("Prefers pnpm", facts, toUnitVector([0.98, 0.1], 2), vectors),
    facts[0]
  )
  assert.equal(
    findDuplicate("Prefers dark mode", facts, toUnitVector([0, 1], 2), vectors),
    undefined
  )

  assert.equal(findDuplicate("Lives in Wrocław Poland", facts), facts[1])
  assert.equal(findDuplicate("Lives in Kraków", facts), undefined)
})

test("rendering groups facts under their category title", () => {
  assert.equal(
    renderFacts([
      { ...fact("stack", "Uses pnpm"), title: "Stack" },
      { ...fact("stack", "Uses Next.js"), title: "Stack" },
    ]),
    "## Stack\n- Uses pnpm\n- Uses Next.js"
  )
})
