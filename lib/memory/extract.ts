import "server-only"

import type { MemorySettings } from "@/lib/settings/schema"
import {
  DEFAULT_MEMORY_CATEGORIES,
  diffMemoryContent,
  isValidMemoryCategory,
  memoryFactLines,
  type MemoryChange,
  type MemoryFile,
  type MemoryUpdateResult,
} from "@/lib/memory/types"
import {
  memoryBytes,
  readMemoryFiles,
  writeMemoryFile,
} from "@/lib/memory/server"
import { normalizeBaseUrl, probeOllama } from "@/lib/providers/ollama-api"

/**
 * The extraction step: a small local model reads what the *user* said this
 * turn, compares it against what is already remembered, and rewrites the
 * categories it wants to change.
 *
 * Two decisions shape everything here.
 *
 * It runs outside the main agent. The chat turn is already finished when this
 * starts, on its own request, against its own (cheap, local) model — so a slow
 * or failing extraction can never delay or break an answer.
 *
 * It rewrites whole categories rather than patching individual facts. That is
 * what lets one call add, correct, merge and shorten at the same time: the
 * model is handed the current file and returns the file it thinks should be
 * there now. A line diff afterwards recovers a readable "what changed", which
 * is the only thing the UI ever shows.
 */

/** Extraction is a background nicety — it never gets to hold up a turn for long. */
const EXTRACT_TIMEOUT_MS = 45_000
/** How many of the user's own messages the extractor sees. */
const RECENT_USER_MESSAGES = 6
/** A single user message longer than this is clipped before it goes in. */
const MAX_MESSAGE_CHARS = 2_000

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
  /\b[A-Za-z0-9_-]{0,8}(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:\d[ -]?){13,19}\b/,
]

/**
 * Categories excluded by default and included only when the user turns them
 * on — the same line Anthropic's own memory draws, and for the same reason:
 * these are the facts whose leaking into an unrelated conversation does real
 * harm, so remembering them has to be a deliberate choice rather than a
 * side effect of having mentioned them once.
 */
const SENSITIVE = [
  /\b(?:diagnos|symptom|illness|disease|medication|prescription|therapy|therapist|depress|anxiety|adhd|autis|disabilit|pregnan|surgery|cancer)\w*/i,
  /\b(?:race|racial|ethnic|ethnicity|nationality|immigrant|refugee)\b/i,
  /\b(?:religio|christian|catholic|muslim|islam|jewish|judaism|hindu|buddhis|atheist|agnostic)\w*/i,
  /\b(?:politic|conservative|liberal|left-wing|right-wing|voted?|party membership|union member)\w*/i,
  /\b(?:gender identity|transgender|trans man|trans woman|non-?binary|gay|lesbian|bisexual|queer|sexual orientation)\b/i,
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

type ExtractedCategory = { category: string; content: string }

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    categories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string" },
          content: { type: "string" },
        },
        required: ["category", "content"],
      },
    },
  },
  required: ["categories"],
} as const

function systemPrompt(categories: string[], budget: number) {
  return [
    "You maintain a small, long-lived memory about one user of a local coding app.",
    "",
    "You are given the user's own recent messages and the memory as it stands.",
    "Return the categories you want to change, each with its COMPLETE new content.",
    "Anything you return REPLACES that category's file, so include every fact that",
    "is still true — a fact you leave out is forgotten.",
    "",
    "Rules:",
    "- Record only durable preferences and facts about the user: how they want",
    "  answers written, their tools and stack, how they work, stable personal",
    "  context. Never record the content of a task, a question they asked, a file",
    "  they were editing, or anything about one specific conversation.",
    "- Merge duplicates and near-duplicates into one line. Shorten wordy lines.",
    "  Prefer rewriting two overlapping facts as one over keeping both.",
    "- When a new message contradicts a remembered fact, replace it. Do not keep",
    "  both the old and the new version.",
    "- One fact per line, written as a plain `- ` bullet, in the third person",
    `  ("Prefers concise answers"), under 120 characters.`,
    "- Never record health, race, ethnicity, religion, politics, gender identity or",
    "  sexual orientation. Never record credentials, identity or financial numbers.",
    "- If nothing durable was said, return an empty categories array. That is the",
    "  common case and it is the right answer — do not invent facts to fill it.",
    "",
    `The whole memory must stay under ${budget} characters across all categories.`,
    `Allowed categories (use these ids exactly): ${categories.join(", ")}.`,
  ].join("\n")
}

function compactionPrompt(budget: number) {
  return [
    "The memory below is over its size budget. Rewrite EVERY category to fit.",
    "",
    "- Merge overlapping and redundant facts into single lines.",
    "- Shorten wordy lines without losing their meaning.",
    "- Drop the least useful facts last, only if merging is not enough.",
    "- Keep every fact that still tells the assistant something it would",
    "  otherwise get wrong.",
    "",
    `Return every category with its complete new content, under ${budget} characters in total.`,
  ].join("\n")
}

function renderMemory(files: MemoryFile[]) {
  if (files.length === 0) return "(the memory is empty)"
  return files
    .map((file) => {
      const lines = memoryFactLines(file.content).filter(
        (line) => !line.startsWith("#")
      )
      return `[${file.category}]\n${lines.join("\n") || "(empty)"}`
    })
    .join("\n\n")
}

type OllamaChatMessage = { role: "system" | "user"; content: string }

/**
 * One non-streaming `/api/chat` round trip. Older servers reject a JSON schema
 * in `format`; they still understand `format: "json"`, so a 400 retries plainly
 * rather than failing the run — the same shape as the `think` retry in the
 * Ollama provider.
 */
async function askForCategories(
  baseUrl: string,
  model: string,
  messages: OllamaChatMessage[],
  signal: AbortSignal
): Promise<ExtractedCategory[]> {
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

  const parsed = JSON.parse(raw) as { categories?: unknown }
  if (!Array.isArray(parsed.categories)) return []
  return parsed.categories.flatMap((entry): ExtractedCategory[] => {
    if (!entry || typeof entry !== "object") return []
    const record = entry as Record<string, unknown>
    const category = typeof record.category === "string" ? record.category : ""
    const content = typeof record.content === "string" ? record.content : ""
    return category && content ? [{ category, content }] : []
  })
}

/** Normalizes one returned category to `- ` bullets, filtered and capped. */
function toFileContent(
  raw: string,
  title: string,
  includeSensitive: boolean
): string {
  const lines = filterFactLines(
    memoryFactLines(raw).map((line) => line.replace(/^[-*+]\s*/, "").trim()),
    includeSensitive
  )
  const unique = [...new Set(lines.filter(Boolean))]
  if (unique.length === 0) return ""
  return `# ${title}\n\n${unique.map((line) => `- ${line}`).join("\n")}`
}

function titleFor(category: string, files: MemoryFile[]) {
  const existing = files.find((file) => file.category === category)
  if (existing) return existing.title
  const preset = DEFAULT_MEMORY_CATEGORIES.find(
    (entry) => entry.category === category
  )
  if (preset) return preset.title
  return category
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * Writes one round of returned categories. Returns how many files it touched,
 * which is all the caller needs — what *changed* is worked out once at the end,
 * against the state the whole run started from, so a fact the extraction pass
 * added and the compaction pass then merged away is not reported as both an
 * addition and a removal.
 */
async function applyCategories(
  returned: ExtractedCategory[],
  files: MemoryFile[],
  allowed: Set<string>,
  includeSensitive: boolean
): Promise<number> {
  let written = 0
  for (const entry of returned) {
    const category = entry.category.trim().toLowerCase()
    if (!isValidMemoryCategory(category) || !allowed.has(category)) continue
    const before = files.find((file) => file.category === category)?.content ?? ""
    const after = toFileContent(
      entry.content,
      titleFor(category, files),
      includeSensitive
    )
    if (!diffMemoryContent(category, before, after)) continue
    await writeMemoryFile(category, after)
    written += 1
  }
  return written
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
  ollamaBaseUrl: string
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
  const { settings } = input
  if (!settings.enabled) return { changes: [], skipped: "disabled" }

  const model = settings.model.trim()
  if (!model) return { changes: [], skipped: "no-model" }

  const baseUrl = normalizeBaseUrl(input.ollamaBaseUrl)
  if (!baseUrl || !(await probeOllama(baseUrl))) {
    return { changes: [], skipped: "unreachable" }
  }

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
    const allowed = new Set(allowedCategories(files))
    const budget = settings.maxChars

    const returned = await askForCategories(
      baseUrl,
      model,
      [
        { role: "system", content: systemPrompt([...allowed], budget) },
        {
          role: "user",
          content: [
            "Memory as it stands:",
            renderMemory(files),
            "",
            "The user's recent messages:",
            said.map((message) => `- ${message}`).join("\n"),
          ].join("\n"),
        },
      ],
      signal
    )

    await applyCategories(returned, files, allowed, settings.includeSensitive)

    /**
     * The cap is enforced after the write, not asked for in the prompt alone:
     * a 3B model will happily promise to stay under a budget and then not.
     * Going over triggers a second pass whose only job is to merge and
     * shorten, which is also what keeps the store from silently accreting
     * near-duplicates over months of use.
     */
    let after = await readMemoryFiles()
    let compacted = false
    if (memoryBytes(after) > budget) {
      const merged = await askForCategories(
        baseUrl,
        model,
        [
          { role: "system", content: compactionPrompt(budget) },
          { role: "user", content: renderMemory(after) },
        ],
        signal
      )
      const written = await applyCategories(
        merged,
        after,
        allowed,
        settings.includeSensitive
      )
      if (written > 0) {
        compacted = true
        after = await readMemoryFiles()
      }
    }

    const changes = netChanges(files, after)
    return {
      changes,
      model,
      compacted,
      bytes: memoryBytes(after),
      ...(changes.length === 0 ? { skipped: "nothing-to-learn" as const } : null),
    }
  } catch {
    return { changes: [], skipped: "failed", model }
  }
}
