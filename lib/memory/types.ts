/**
 * Wire + on-disk shapes for the user memory layer. Types and pure helpers
 * only, so the settings page, the chat page and `node --test` can import them
 * without dragging `node:fs` into anything.
 *
 * Memory works the way Claude Code's does: a small directory of markdown
 * *topic* files under `~/.agent-ui/memory`, each opening with a one-line
 * description, and the agent itself keeps them — it is shown the index (and
 * the bodies that fit), and it updates, merges or deletes a file when what the
 * user says makes one wrong. No second model guesses at it after the turn.
 *
 * Plain files on purpose: a user can open, read and correct what the app
 * remembers about them with any editor.
 */

/** One topic file. */
export type MemoryFile = {
  /** Slug, and the file's basename: `preferences` → `preferences.md`. */
  name: string
  /** One line: what this file holds and when it matters. The index shows it. */
  description: string
  /** Markdown body, frontmatter stripped. */
  content: string
  updatedAt: number
  bytes: number
}

/**
 * The store stays small by construction. A new file past the cap is refused
 * with the names that exist, which is what pushes an agent to update or merge
 * rather than spawn `preferences-2`. Claude Code's memory has the same shape:
 * a handful of topic files, kept current, never a log.
 */
export const MAX_MEMORY_FILES = 12
/** One file's body. A topic that outgrows this is two topics, or too detailed. */
export const MAX_MEMORY_FILE_CHARS = 4_000
export const MAX_MEMORY_DESCRIPTION_CHARS = 160

/** Names suggested to the agent and the settings page for a fresh store. */
export const SUGGESTED_MEMORY_FILES: Array<{ name: string; description: string }> = [
  {
    name: "preferences",
    description: "How answers should be written: length, tone, language, formatting.",
  },
  {
    name: "profile",
    description: "Durable facts about the user: role, timezone, what they work on.",
  },
  {
    name: "stack",
    description: "Languages, frameworks, tools and versions they actually use.",
  },
  {
    name: "workflow",
    description: "How they work: conventions, review habits, testing and deploy process.",
  },
]

/** Names become file names — kept to an alphabet with no `.` and no separator. */
export function isValidMemoryName(id: string) {
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(id)
}

/** Free text → a file name, for the "new file" field and lenient tool calls. */
export function toMemoryName(input: string) {
  return input
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function titleCase(name: string) {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * Splits a file into its description and body.
 *
 * The format is `---\ndescription: …\n---\n\nbody`. A file written before
 * that format — `# Title` and bullets, which is what the old extractor left —
 * still reads: its heading becomes the description and stays in the body.
 */
export function parseMemoryFile(
  name: string,
  raw: string
): { description: string; content: string } {
  const text = raw.replace(/^﻿/, "")
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (front) {
    const description =
      front[1].match(/^description:[ \t]*(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ??
      ""
    return {
      description: description || titleCase(name),
      content: text.slice(front[0].length).trim(),
    }
  }
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return { description: heading || titleCase(name), content: text.trim() }
}

/** The on-disk form `parseMemoryFile` reads back. */
export function serializeMemoryFile(description: string, content: string) {
  const line = description.replace(/\s+/g, " ").trim()
  const body = content.trim()
  return `---\ndescription: ${line}\n---\n${body ? `\n${body}\n` : ""}`
}

/** Lines that carry something — what the settings page counts. */
export function memoryLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !/^[-*+]\s*$/.test(line))
}

/**
 * Why a write would be refused, or null when it may land. Shared by the MCP
 * tool and the settings route, so an agent and a person hit the same limits —
 * and the refusals are written for the agent, since it is the one that has to
 * act on them.
 */
export function memoryWriteError(
  input: { name: string; description: string; content: string },
  existing: string[]
): string | null {
  if (!isValidMemoryName(input.name)) {
    return "`name` must be lowercase letters, digits and dashes (it becomes the file name), e.g. `preferences`."
  }
  if (!input.description.trim()) {
    return "`description` is required: one line saying what this file holds, so it can be found from the index."
  }
  if (input.description.length > MAX_MEMORY_DESCRIPTION_CHARS) {
    return `\`description\` must be one line under ${MAX_MEMORY_DESCRIPTION_CHARS} characters.`
  }
  if (input.content.length > MAX_MEMORY_FILE_CHARS) {
    return `This file would be ${input.content.length} characters; the limit is ${MAX_MEMORY_FILE_CHARS}. Condense it — drop what is outdated or too specific — or split off a distinct topic.`
  }
  if (!existing.includes(input.name) && existing.length >= MAX_MEMORY_FILES) {
    return `Memory already has ${existing.length} files (the limit is ${MAX_MEMORY_FILES}): ${existing.join(", ")}. Put this into the existing file it belongs to, or merge two related files and delete one, instead of creating a new one.`
  }
  return null
}

/** Whether memory can be written to, as the settings page sees it. */
export type MemoryStore = {
  /** Absolute path of the memory directory. */
  dir: string
  files: MemoryFile[]
  /** Characters across every body, shown against the per-turn budget. */
  bytes: number
}
