/**
 * Choosing which remembered facts a turn is handed, and recognising a fact the
 * store already holds. Pure and free of `node:` so it runs under `node --test`
 * — the I/O half (Ollama, the vector cache) is `lib/memory/embed.ts`.
 *
 * The shape follows what the coding CLIs converged on rather than a vector
 * database. Claude Code loads a short always-on file and lets the agent read
 * the rest on demand; Codex injects a bounded summary and keeps a registry the
 * agent greps. Both say the same thing: a small core is always present, the
 * long tail is *looked up*. Here the core is the categories that describe how
 * to answer at all (`ALWAYS_ON_CATEGORIES`), the long tail is ranked against
 * the prompt by EmbeddingGemma, and a store small enough to fit is simply sent
 * whole — ranking a store that fits can only lose facts, never gain any.
 */

import { memoryFactLines, type MemoryFile } from "@/lib/memory/types"

/** One remembered line, addressable by its normalized text. */
export type MemoryFact = {
  /** `factKey(text)` — what the vector cache is keyed by. */
  key: string
  category: string
  /** The category's display title, for rendering. */
  title: string
  text: string
}

/**
 * Categories every turn gets regardless of the prompt: how the user wants
 * answers written is relevant to *every* answer, which is the one thing a
 * similarity score against the prompt cannot see.
 */
export const ALWAYS_ON_CATEGORIES = new Set(["preferences"])

/**
 * Cosine at or above which a new fact is the same fact reworded. Measured on
 * EmbeddingGemma's document side, where a paraphrase sits around 0.9–0.97 and
 * two different facts about the same tool sit around 0.75–0.85.
 */
export const DUPLICATE_SIMILARITY = 0.92
/** Below this a fact has nothing to do with the prompt, however few there are. */
export const MIN_RELEVANCE = 0.3
/** Lexical stand-in for `DUPLICATE_SIMILARITY` when no embedder is available. */
const LEXICAL_DUPLICATE = 0.8
/** MMR trade-off: mostly relevance, enough diversity that near-twins do not crowd the budget. */
const MMR_LAMBDA = 0.75

/** Lowercased, whitespace-collapsed, bullet and trailing period stripped. */
export function factKey(text: string) {
  return text
    .replace(/^[-*+]\s*/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!]+$/, "")
    .trim()
}

export function factsFromFiles(files: MemoryFile[]): MemoryFact[] {
  const facts: MemoryFact[] = []
  const seen = new Set<string>()
  for (const file of files) {
    for (const line of memoryFactLines(file.content)) {
      const text = line.replace(/^[-*+]\s*/, "").trim()
      const key = factKey(text)
      if (!key || seen.has(key)) continue
      seen.add(key)
      facts.push({ key, category: file.category, title: file.title, text })
    }
  }
  return facts
}

/*
 * EmbeddingGemma is trained with task prompts on both sides, and the model
 * card's retrieval numbers assume them. Ollama's tag carries no template, so
 * the caller adds them — leaving them off costs measurable recall.
 */
export function queryInput(text: string) {
  return `task: search result | query: ${text}`
}

export function documentInput(text: string) {
  return `title: none | text: ${text}`
}

/**
 * Matryoshka truncation then L2 normalization. EmbeddingGemma is trained so
 * the first 256 of its 768 dimensions stand on their own, which makes the
 * cache a third of the size for a recall loss nobody can see at this scale.
 */
export function toUnitVector(raw: ArrayLike<number>, dims: number) {
  const length = Math.min(dims, raw.length)
  const out = new Float32Array(length)
  let norm = 0
  for (let i = 0; i < length; i++) {
    out[i] = raw[i]
    norm += raw[i] * raw[i]
  }
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < length; i++) out[i] /= norm
  return out
}

/** Dot product — the cosine, since every stored vector is unit length. */
export function similarity(a: Float32Array, b: Float32Array) {
  const length = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < length; i++) dot += a[i] * b[i]
  return dot
}

const STOPWORDS = new Set(
  "a an and are as at be but by do does for from has have how i in is it its me my of on or so that the this to use uses was we what when with you your".split(
    " "
  )
)

function tokens(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((token) => token.replace(/\.+$/, ""))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
}

/**
 * The fallback when the embedder is unavailable: idf-weighted term overlap,
 * scaled so the best fact scores 1. Crude next to an embedding — it cannot
 * see that "pnpm" answers a question about installing packages — but it is
 * deterministic, needs nothing running, and is right about the facts that
 * share a word with the prompt, which are most of the ones that matter.
 */
export function lexicalScores(query: string, facts: MemoryFact[]) {
  const wanted = new Set(tokens(query))
  const scores = new Map<string, number>()
  if (wanted.size === 0 || facts.length === 0) return scores
  const docs = facts.map((fact) => new Set(tokens(fact.text)))
  const df = new Map<string, number>()
  for (const doc of docs) for (const token of doc) df.set(token, (df.get(token) ?? 0) + 1)
  let best = 0
  const raw = docs.map((doc) => {
    let score = 0
    for (const token of doc) {
      if (!wanted.has(token)) continue
      score += Math.log(1 + facts.length / (df.get(token) ?? 1))
    }
    score /= Math.sqrt(Math.max(1, doc.size))
    best = Math.max(best, score)
    return score
  })
  facts.forEach((fact, index) => {
    if (raw[index] > 0) scores.set(fact.key, raw[index] / best)
  })
  return scores
}

/** Token-set Jaccard, for spotting a duplicate without an embedder. */
function jaccard(a: string, b: string) {
  const left = new Set(tokens(a))
  const right = new Set(tokens(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return shared / (left.size + right.size - shared)
}

/**
 * The existing fact a candidate restates, if any. Exact key first, then the
 * embedding, then — without one — word overlap, which is stricter on purpose:
 * a missed duplicate costs a line, a false one throws a new fact away.
 */
export function findDuplicate(
  text: string,
  facts: MemoryFact[],
  vector?: Float32Array,
  vectors?: Map<string, Float32Array>
): MemoryFact | undefined {
  const key = factKey(text)
  const exact = facts.find((fact) => fact.key === key)
  if (exact) return exact
  if (vector && vectors) {
    let best: MemoryFact | undefined
    let bestScore = DUPLICATE_SIMILARITY
    for (const fact of facts) {
      const other = vectors.get(fact.key)
      if (!other) continue
      const score = similarity(vector, other)
      if (score >= bestScore) {
        best = fact
        bestScore = score
      }
    }
    return best
  }
  return facts.find((fact) => jaccard(fact.text, text) >= LEXICAL_DUPLICATE)
}

/** Characters a fact costs in the rendered block: the bullet and the newline. */
function cost(fact: MemoryFact) {
  return fact.text.length + 3
}

export type MemorySelection = {
  facts: MemoryFact[]
  /** Facts left out of this turn — the agent is told they exist. */
  omitted: number
  /** Whether a ranking decided the cut, rather than everything fitting. */
  ranked: boolean
}

/**
 * Picks the facts one turn is handed, within `budget` characters.
 *
 * Everything when everything fits. Otherwise the always-on categories first
 * (capped at half the budget, so a sprawling preferences file cannot starve
 * the rest), then the rest by maximal marginal relevance over `scores`: each
 * pick is the fact most relevant to the prompt *and* least like what is
 * already picked, so three phrasings of "uses TypeScript" cannot fill the
 * room a relevant fact needed. Without vectors MMR degrades to plain ranking.
 */
export function selectMemory(input: {
  facts: MemoryFact[]
  budget: number
  scores: Map<string, number>
  vectors?: Map<string, Float32Array>
  minScore?: number
}): MemorySelection {
  const { facts, budget, scores, vectors } = input
  const total = facts.reduce((sum, fact) => sum + cost(fact), 0)
  if (total <= budget) return { facts, omitted: 0, ranked: false }

  const picked: MemoryFact[] = []
  let used = 0
  const take = (fact: MemoryFact) => {
    picked.push(fact)
    used += cost(fact)
  }

  for (const fact of facts) {
    if (!ALWAYS_ON_CATEGORIES.has(fact.category)) continue
    if (used + cost(fact) > budget / 2) continue
    take(fact)
  }

  const minScore = input.minScore ?? (vectors ? MIN_RELEVANCE : 0)
  const pool = facts.filter(
    (fact) =>
      !picked.includes(fact) && (scores.get(fact.key) ?? 0) > minScore
  )
  while (pool.length > 0) {
    let bestIndex = -1
    let bestValue = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const fact = pool[i]
      if (used + cost(fact) > budget) continue
      const relevance = scores.get(fact.key) ?? 0
      let redundancy = 0
      const vector = vectors?.get(fact.key)
      if (vector) {
        for (const chosen of picked) {
          const other = vectors?.get(chosen.key)
          if (other) redundancy = Math.max(redundancy, similarity(vector, other))
        }
      }
      const value = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * redundancy
      if (value > bestValue) {
        bestValue = value
        bestIndex = i
      }
    }
    if (bestIndex < 0) break
    take(pool[bestIndex])
    pool.splice(bestIndex, 1)
  }

  // Back in store order, so a category reads as the file does.
  const order = new Map(facts.map((fact, index) => [fact.key, index]))
  picked.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
  return { facts: picked, omitted: facts.length - picked.length, ranked: true }
}

/** `## Title` sections of `- ` bullets, in the order the facts arrive. */
export function renderFacts(facts: MemoryFact[]) {
  const sections = new Map<string, { title: string; lines: string[] }>()
  for (const fact of facts) {
    const section = sections.get(fact.category) ?? { title: fact.title, lines: [] }
    section.lines.push(`- ${fact.text}`)
    sections.set(fact.category, section)
  }
  return [...sections.values()]
    .map((section) => `## ${section.title}\n${section.lines.join("\n")}`)
    .join("\n\n")
}
