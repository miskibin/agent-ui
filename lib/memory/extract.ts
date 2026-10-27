import "server-only"

import type { MemorySettings } from "@/lib/settings/schema"
import {
  DEFAULT_MEMORY_CATEGORIES,
  diffMemoryContent,
  isValidMemoryCategory,
  memoryTitleFrom,
  type MemoryChange,
  type MemoryFile,
  type MemoryUpdateResult,
} from "@/lib/memory/types"
import {
  memoryBytes,
  readMemoryFiles,
  writeMemoryFile,
} from "@/lib/memory/server"
import { embedDocuments, embedQuery, factVectors } from "@/lib/memory/embed"
import {
  factKey,
  factsFromFiles,
  findDuplicate,
  lexicalScores,
  similarity,
  type MemoryFact,
} from "@/lib/memory/retrieve"
import { parseJsonObject } from "@/lib/json-rescue"

/**
 * The write path: a small local model reads what the *user* said, is shown the
 * remembered facts that relate to it, and answers with operations — add a
 * fact, update one, delete one — rather than with files.
 *
 * This is the shape Mem0 settled on and the coding CLIs' memory pipelines
 * share (Codex extracts per session, then consolidates against what exists):
 * the model never rewrites the store, it edits it. Two things follow.
 *
 * The store can outgrow the prompt. The model is shown the *related* facts —
 * ranked by EmbeddingGemma against the user's messages — not all of them, so
 * the hundredth fact costs this call nothing and nothing has to be shortened
 * to fit a context window.
 *
 * Nothing is lost by omission. A whole-file rewrite forgot every fact the
 * model happened to leave out; an operation list can only touch what it
 * names. And an `add` that restates an existing fact is caught after the
 * model, by the same embedding (`findDuplicate`), because a 3B model told
 * "do not duplicate" will still duplicate.
 *
 * It runs outside the chat turn, on its own request, so a slow or failing
 * extraction never delays an answer.
 */

/** Extraction is a background nicety — it never gets to hold up a turn for long. */
const EXTRACT_TIMEOUT_MS = 45_000
/** How many of the user's own messages the extractor sees. */
const RECENT_USER_MESSAGES = 6
/** A single user message longer than this is clipped before it goes in. */
const MAX_MESSAGE_CHARS = 2_000
/** A store this small is shown to the extractor whole; ranking it saves nothing. */
const SHOW_ALL_BELOW = 40
/** Otherwise, how many related facts the extractor is shown. */
const RELATED_FACTS = 24
/** Below this a fact is unrelated to what was said and is not worth the model's attention. */
const RELATED_MIN = 0.25
/** Hard ceiling on the store; past it nothing is added until something is removed. */
export const MAX_MEMORY_FACTS = 500

/**
 * Categories are never invented from nothing: the model picks from the ones
 * that exist plus the defaults, so a rambling turn cannot spawn `misc-2`.
 */
function allowedCategories(files: MemoryFile[]) {
  const ids = new Set(DEFAULT_MEMORY_CATEGORIES.map((entry) => entry.category))
  for (const file of files) ids.add(file.category)
  return [...ids]
}

/**
 * Facts that are never written, whatever the settings say. Identity documents,
 * financial instruments and credentials have no business in a file that is
 * pasted into every future prompt — including prompts sent to a different
 * backend than the one that heard them.
 */
const ALWAYS_BLOCKED = [
  /\b(?:ssn|social security|pesel|passport|national insurance|nin|tax id|driver'?s licen[cs]e)\b/i,
  /\b(?:credit card|iban|swift|routing number|account number|cvv)\b/i,
  /\b(?:password|api[- ]?key|secret key|access token|private key|seed phrase)\b/i,
  /\b(?:criminal record|conviction|arrest|immigration status|visa status|deportation)\b/i,
  /(?<![A-Za-z0-9_-])(?:sk|pk)-[A-Za-z0-9]{20,}(?![A-Za-z0-9])/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:\d[ -]?){13,19}\b/,
]

/**
 * Categories excluded by default and included only when the user turns them
 * on.
 *
 * These patterns are deliberately narrow. Because the extractor rewrites whole
 * categories, a false positive does not merely decline to store a fact — it
 * *deletes* one that is already there on the next pass. So terms that double as
 * ordinary technical vocabulary stay out: bare `race` (race conditions),
 * `conservative`/`liberal` (dependency ranges, timeouts), `therapy` (therapy
 * as in `retry`), `surgery`. What is left needs the sensitive reading to match
 * at all.
 *
 * The original intent — the same line Anthropic's own memory draws, and for the same reason:
 * these are the facts whose leaking into an unrelated conversation does real
 * harm, so remembering them has to be a deliberate choice rather than a
 * side effect of having mentioned them once.
 */
const SENSITIVE = [
  /\b(?:diagnos|symptom|illness|disease|medication|prescription|therapist|depress|anxiety|adhd|autis|disabilit|pregnan|cancer)\w*/i,
  /\b(?:racial|ethnicity|ethnic (?:origin|background|group)|nationality|immigrant|refugee)\b/i,
  /\b(?:religio|christian|catholic|muslim|islam|jewish|judaism|hindu|buddhis|atheist|agnostic)\w*/i,
  /\b(?:politically|political (?:views?|beliefs?|party|affiliation)|left-wing|right-wing|party membership|union member)\b/i,
  /\bvot(?:es?|ed|ing) for\b/i,
  /\b(?:gender identity|transgender|trans man|trans woman|non-?binary|lesbian|bisexual|sexual orientation)\b/i,
]

/** Which of a category's lines are safe to keep, under the current settings. */
function filterFactLines(lines: string[], includeSensitive: boolean) {
  return lines.filter((line) => {
    if (ALWAYS_BLOCKED.some((pattern) => pattern.test(line))) return false
    if (!includeSensitive && SENSITIVE.some((pattern) => pattern.test(line))) {
      return false
    }
    return true
  })
}

type Operation =
  | { op: "add"; category: string; text: string }
  | { op: "update"; id: string; text: string }
  | { op: "delete"; id: string }

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "update", "delete"] },
          id: { type: "string" },
          category: { type: "string" },
          text: { type: "string" },
        },
        required: ["op"],
      },
    },
  },
  required: ["operations"],
} as const

function systemPrompt(categories: string[]) {
  const hints = categories.map((category) => {
    const preset = DEFAULT_MEMORY_CATEGORIES.find(
      (entry) => entry.category === category
    )
    return preset ? `- ${category}: ${preset.hint}` : `- ${category}`
  })
  return [
    "You maintain a long-lived memory about one user of a local coding app.",
    "",
    "You are given the user's own recent messages and the remembered facts that",
    "relate to them, each with an id. Answer with the operations that bring the",
    "memory up to date:",
    `- {"op":"add","category":"<id>","text":"<fact>"} for something new and durable`,
    `- {"op":"update","id":"<fact id>","text":"<fact>"} when a message refines or`,
    "  corrects a remembered fact, or two facts should become one (update one,",
    "  delete the other)",
    `- {"op":"delete","id":"<fact id>"} when the user contradicts or retracts it`,
    "Facts you do not name are kept as they are.",
    "",
    "Rules:",
    "- Record only durable preferences and facts about the user: how they want",
    "  answers written, their tools and stack, how they work, stable personal",
    "  context. Never record the content of a task, a question they asked, a file",
    "  they were editing, or anything about one specific conversation.",
    "- Never add a fact that a remembered one already says. Update it instead.",
    "- One fact per text, third person (\"Prefers concise answers\"), under 120",
    "  characters, no leading bullet.",
    "- Never record health, race, ethnicity, religion, politics, gender identity or",
    "  sexual orientation. Never record credentials, identity or financial numbers.",
    "- If nothing durable was said, return an empty operations array. That is the",
    "  common case and it is the right answer — do not invent facts to fill it.",
    "",
    "Categories (use these ids exactly):",
    ...hints,
  ].join("\n")
}

type OllamaChatMessage = { role: "system" | "user"; content: string }

/**
 * One non-streaming `/api/chat` round trip. Older servers reject a JSON schema
 * in `format`; they still understand `format: "json"`, so a 400 retries plainly
 * rather than failing the run — the same shape as the `think` retry in the
 * Ollama provider.
 */
async function askForOperations(
  baseUrl: string,
  model: string,
  messages: OllamaChatMessage[],
  signal: AbortSignal
): Promise<Operation[]> {
  const post = (format: unknown) =>
    fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        format,
        options: { temperature: 0 },
      }),
      cache: "no-store",
      signal,
    })

  let res = await post(RESPONSE_SCHEMA)
  if (res.status === 400) res = await post("json")
  if (!res.ok) throw new Error(`Ollama /api/chat failed (${res.status})`)

  const data = (await res.json()) as { message?: { content?: string } }
  const raw = data.message?.content?.trim()
  if (!raw) return []

  // The `format: "json"` fallback is a small model left to its own devices,
  // and one of those will open with "Here is the JSON:" or fence the object.
  const parsed = parseJsonObject<{ operations?: unknown }>(raw)
  if (!parsed || !Array.isArray(parsed.operations)) return []
  return parsed.operations.flatMap((entry): Operation[] => {
    if (!entry || typeof entry !== "object") return []
    const record = entry as Record<string, unknown>
    const str = (key: string) =>
      typeof record[key] === "string" ? (record[key] as string).trim() : ""
    const text = str("text").replace(/^[-*+]\s*/, "")
    switch (record.op) {
      case "add":
        return text && str("category")
          ? [{ op: "add", category: str("category").toLowerCase(), text }]
          : []
      case "update":
        return text && str("id") ? [{ op: "update", id: str("id"), text }] : []
      case "delete":
        return str("id") ? [{ op: "delete", id: str("id") }] : []
      default:
        return []
    }
  })
}

function titleFor(category: string, files: MemoryFile[]) {
  const existing = files.find((file) => file.category === category)
  if (existing) return existing.title
  const preset = DEFAULT_MEMORY_CATEGORIES.find(
    (entry) => entry.category === category
  )
  return preset ? preset.title : memoryTitleFrom(category, "")
}

/**
 * The facts the extractor is shown, with the short ids it answers in. A small
 * store goes whole; a larger one is ranked against what the user said —
 * EmbeddingGemma when it runs, word overlap when it does not.
 */
async function relatedFacts(
  baseUrl: string,
  embedModel: string,
  said: string,
  facts: MemoryFact[],
  signal: AbortSignal
): Promise<{
  related: MemoryFact[]
  vectors?: Map<string, Float32Array>
}> {
  let vectors: Map<string, Float32Array> | undefined
  let scores: Map<string, number>
  try {
    vectors = await factVectors(baseUrl, embedModel, facts, signal)
    const query = await embedQuery(baseUrl, embedModel, said, signal)
    scores = new Map(
      facts.flatMap((fact) => {
        const vector = vectors?.get(fact.key)
        return vector ? [[fact.key, similarity(query, vector)] as const] : []
      })
    )
  } catch {
    vectors = undefined
    scores = lexicalScores(said, facts)
  }
  if (facts.length <= SHOW_ALL_BELOW) return { related: facts, vectors }
  const related = facts
    .filter((fact) => (scores.get(fact.key) ?? 0) > (vectors ? RELATED_MIN : 0))
    .sort((a, b) => (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0))
    .slice(0, RELATED_FACTS)
  return { related, vectors }
}

/**
 * Applies the operations to an in-memory copy of the store and writes back
 * only the categories that changed. Every text passes the same filters; every
 * `add` is checked against the whole store — and against the adds before it —
 * for a fact it merely restates.
 */
async function applyOperations(input: {
  operations: Operation[]
  ids: Map<string, MemoryFact>
  files: MemoryFile[]
  facts: MemoryFact[]
  allowed: Set<string>
  includeSensitive: boolean
  baseUrl: string
  embedModel: string
  vectors?: Map<string, Float32Array>
  signal: AbortSignal
}) {
  const { operations, ids, files, allowed, includeSensitive } = input
  const keep = (text: string) => filterFactLines([text], includeSensitive).length > 0

  // category → its lines, in file order; the unit everything is written back in.
  const lines = new Map<string, string[]>()
  for (const fact of input.facts) {
    lines.set(fact.category, [...(lines.get(fact.category) ?? []), fact.text])
  }
  const touched = new Set<string>()
  const replace = (fact: MemoryFact, text: string | null) => {
    const list = lines.get(fact.category) ?? []
    const index = list.indexOf(fact.text)
    if (index < 0) return
    if (text === null) list.splice(index, 1)
    else list[index] = text
    lines.set(fact.category, list)
    touched.add(fact.category)
  }

  const adds = operations.filter(
    (op): op is Extract<Operation, { op: "add" }> =>
      op.op === "add" &&
      allowed.has(op.category) &&
      isValidMemoryCategory(op.category) &&
      keep(op.text)
  )
  let addVectors: Float32Array[] | undefined
  if (input.vectors && adds.length > 0) {
    addVectors = await embedDocuments(
      input.baseUrl,
      input.embedModel,
      adds.map((op) => op.text),
      input.signal
    ).catch(() => undefined)
  }
  const vectors = new Map(input.vectors ?? [])

  for (const op of operations) {
    if (op.op === "delete") {
      const fact = ids.get(op.id)
      if (fact) replace(fact, null)
    } else if (op.op === "update") {
      const fact = ids.get(op.id)
      if (!fact || factKey(op.text) === fact.key) continue
      // An update whose new text the filters refuse removes the old one: it
      // was the model saying the remembered line is wrong.
      replace(fact, keep(op.text) ? op.text : null)
    }
  }

  // What the store holds once the deletes and updates have landed — an add
  // that restates a fact the model just removed is not a duplicate of it.
  const known: MemoryFact[] = [...lines].flatMap(([category, list]) =>
    list.map((text) => ({
      key: factKey(text),
      category,
      title: titleFor(category, files),
      text,
    }))
  )
  let count = known.length
  adds.forEach((op, index) => {
    if (count >= MAX_MEMORY_FACTS) return
    const vector = addVectors?.[index]
    if (findDuplicate(op.text, known, vector, addVectors ? vectors : undefined)) {
      return
    }
    const fact: MemoryFact = {
      key: factKey(op.text),
      category: op.category,
      title: titleFor(op.category, files),
      text: op.text,
    }
    known.push(fact)
    if (vector) vectors.set(fact.key, vector)
    lines.set(op.category, [...(lines.get(op.category) ?? []), op.text])
    touched.add(op.category)
    count += 1
  })

  for (const category of touched) {
    const list = [...new Set(lines.get(category) ?? [])]
    const title = titleFor(category, files)
    // A category emptied by deletes keeps its heading: the user made it, or
    // it is a default, and either way it is a place facts go.
    await writeMemoryFile(
      category,
      list.length > 0
        ? `# ${title}\n\n${list.map((line) => `- ${line}`).join("\n")}`
        : `# ${title}\n`
    )
  }
  return touched.size
}

/** Net change across the whole run: the snapshot it started from vs. the files now. */
function netChanges(before: MemoryFile[], after: MemoryFile[]): MemoryChange[] {
  const categories = new Set([
    ...before.map((file) => file.category),
    ...after.map((file) => file.category),
  ])
  const changes: MemoryChange[] = []
  for (const category of categories) {
    const change = diffMemoryContent(
      category,
      before.find((file) => file.category === category)?.content ?? "",
      after.find((file) => file.category === category)?.content ?? ""
    )
    if (change) changes.push(change)
  }
  return changes
}

export type ExtractInput = {
  settings: MemorySettings
  /** The reachable Ollama server (`memoryOllama`), or undefined for none. */
  baseUrl: string | undefined
  /** The user's own messages from this thread, oldest first. Nothing else. */
  userMessages: string[]
  signal?: AbortSignal
}

/**
 * Runs one extraction pass and returns what changed.
 *
 * Never throws: a memory update that fails is a background chore that did not
 * happen, reported as `skipped: "failed"`, not an error the chat has to care
 * about.
 *
 * Note what is *not* in `ExtractInput`: assistant replies, tool calls, tool
 * output, file contents. The extractor only ever reads what the person typed.
 * That is the containment boundary for this feature — a README in a cloned
 * repo cannot talk its way into a file that is pasted into every future
 * prompt, because the extractor never sees a README.
 */
export async function extractMemory(
  input: ExtractInput
): Promise<MemoryUpdateResult> {
  const { settings, baseUrl } = input
  if (!settings.enabled) return { changes: [], skipped: "disabled" }

  const model = settings.model.trim()
  if (!model) return { changes: [], skipped: "no-model" }
  if (!baseUrl) return { changes: [], skipped: "unreachable" }

  const said = input.userMessages
    .map((message) => message.trim())
    .filter(Boolean)
    .slice(-RECENT_USER_MESSAGES)
    .map((message) => message.slice(0, MAX_MESSAGE_CHARS))
  if (said.length === 0) return { changes: [], skipped: "nothing-to-learn" }

  const timeout = AbortSignal.timeout(EXTRACT_TIMEOUT_MS)
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout

  try {
    const files = await readMemoryFiles()
    const facts = factsFromFiles(files)
    const allowed = new Set(allowedCategories(files))

    const { related, vectors } = await relatedFacts(
      baseUrl,
      settings.embedModel,
      said.join("\n"),
      facts,
      signal
    )
    // Short ids, not the text: a small model copies `f3` reliably and a
    // sentence not at all.
    const ids = new Map(related.map((fact, index) => [`f${index + 1}`, fact]))
    const remembered =
      related.length === 0
        ? "(nothing related is remembered)"
        : [...ids]
            .map(([id, fact]) => `${id} [${fact.category}] ${fact.text}`)
            .join("\n")

    const operations = await askForOperations(
      baseUrl,
      model,
      [
        { role: "system", content: systemPrompt([...allowed]) },
        {
          role: "user",
          content: [
            "Remembered facts related to these messages:",
            remembered,
            "",
            "The user's recent messages (the last one is the newest):",
            said.map((message) => `- ${message}`).join("\n"),
          ].join("\n"),
        },
      ],
      signal
    )

    await applyOperations({
      operations,
      ids,
      files,
      facts,
      allowed,
      includeSensitive: settings.includeSensitive,
      baseUrl,
      embedModel: settings.embedModel,
      vectors,
      signal,
    })

    const after = await readMemoryFiles()
    const changes = netChanges(files, after)
    // Warm the cache for the facts just written, so the next turn's ranking
    // embeds nothing. Best-effort: a miss here is paid on that turn instead.
    if (vectors && changes.length > 0) {
      await factVectors(baseUrl, settings.embedModel, factsFromFiles(after), signal).catch(
        () => undefined
      )
    }
    return {
      changes,
      model,
      ranking: vectors ? "embedding" : "lexical",
      bytes: memoryBytes(after),
      ...(changes.length === 0 ? { skipped: "nothing-to-learn" as const } : null),
    }
  } catch {
    return { changes: [], skipped: "failed", model }
  }
}
