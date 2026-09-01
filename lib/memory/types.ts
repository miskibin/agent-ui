/**
 * Wire + on-disk shapes for the user memory layer. Types and pure helpers
 * only, so the settings page and the chat page can import them without
 * dragging `node:fs` into the client bundle.
 *
 * Memory is a directory of small markdown files under `~/.agent-ui/memory`,
 * one per category. Plain files on purpose: the whole point of the feature is
 * that a user can open, read and correct what the app remembers about them.
 */

/** One category file. `content` is markdown — in practice a list of one-line facts. */
export type MemoryFile = {
  /** Slug, and the file's basename: `preferences` → `preferences.md`. */
  category: string
  /** Human label, taken from the file's `# ` heading when it has one. */
  title: string
  content: string
  updatedAt: number
  bytes: number
}

/**
 * What one extraction run did to one category, derived by diffing the file
 * before and after. The extractor rewrites whole categories (that is what lets
 * it merge and shorten), so the per-line diff is the only place a readable
 * "what changed" exists.
 */
export type MemoryChange = {
  category: string
  added: string[]
  removed: string[]
}

/** Why an update run produced nothing — surfaced instead of a silent no-op. */
export type MemorySkipReason =
  | "disabled"
  | "no-model"
  | "unreachable"
  | "nothing-to-learn"
  | "failed"

export type MemoryUpdateResult = {
  changes: MemoryChange[]
  /** Present when the run deliberately did nothing. */
  skipped?: MemorySkipReason
  /** Ollama model that ran the extraction, for the details line. */
  model?: string
  /** True when the run had to merge and shorten to fit the character budget. */
  compacted?: boolean
  /** Total characters across all category files after the run. */
  bytes?: number
}

/** Categories a fresh install starts with. Users can add, rename and delete. */
export const DEFAULT_MEMORY_CATEGORIES: Array<{
  category: string
  title: string
  hint: string
}> = [
  {
    category: "preferences",
    title: "Preferences",
    hint: "How answers should be written: length, tone, language, formatting.",
  },
  {
    category: "profile",
    title: "Profile",
    hint: "Durable facts about the person: role, timezone, what they work on.",
  },
  {
    category: "stack",
    title: "Stack",
    hint: "Languages, frameworks, tools and versions they actually use.",
  },
  {
    category: "workflow",
    title: "Workflow",
    hint: "How they work: conventions, review habits, deploy and test process.",
  },
]

/** Ids become file names — keep them to a known-safe alphabet. */
export function isValidMemoryCategory(id: string) {
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(id)
}

/** Free text → a category id, for the "add category" field in settings. */
export function toMemoryCategoryId(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

/** `# Title` on the first line, falling back to a title-cased slug. */
export function memoryTitleFrom(category: string, content: string) {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (heading) return heading
  return category
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * The lines of a category that carry facts — bullets and prose, minus the
 * heading and blank lines. Both the prompt budget and the change diff count
 * in these, so they agree on what a "fact" is.
 */
export function memoryFactLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

/** Added / removed fact lines between two versions of one category. */
export function diffMemoryContent(
  category: string,
  before: string,
  after: string
): MemoryChange | null {
  const previous = memoryFactLines(before)
  const next = memoryFactLines(after)
  const had = new Set(previous)
  const has = new Set(next)
  const added = next.filter((line) => !had.has(line))
  const removed = previous.filter((line) => !has.has(line))
  if (added.length === 0 && removed.length === 0) return null
  return { category, added, removed }
}

/** "2 added, 1 merged" — the one-liner the toast and the inline notice share. */
export function summarizeMemoryChanges(changes: MemoryChange[]) {
  const added = changes.reduce((total, change) => total + change.added.length, 0)
  const removed = changes.reduce(
    (total, change) => total + change.removed.length,
    0
  )
  const parts: string[] = []
  if (added > 0) parts.push(`${added} added`)
  // A removal that comes with additions in the same category is the extractor
  // rewriting a fact, not forgetting one — say so rather than alarming anyone.
  if (removed > 0) {
    const merged = changes.some(
      (change) => change.removed.length > 0 && change.added.length > 0
    )
    parts.push(`${removed} ${merged ? "rewritten" : "removed"}`)
  }
  return parts.join(", ") || "no changes"
}
