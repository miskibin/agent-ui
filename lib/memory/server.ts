import "server-only"

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { dataDir } from "@/lib/settings/server"
import {
  DEFAULT_MEMORY_CATEGORIES,
  isValidMemoryCategory,
  memoryFactLines,
  memoryTitleFrom,
  type MemoryFile,
} from "@/lib/memory/types"

/**
 * The on-disk half of the memory layer: one markdown file per category under
 * `~/.agent-ui/memory` (or `$AGENT_UI_DIR/memory`).
 *
 * Deliberately a sibling of `sessions/` rather than a key in settings.json:
 * memory is the one thing here a user may want to read, edit, export or shred
 * on its own, and a directory of plain files is the cheapest way to make all
 * four possible without the app's cooperation.
 */

export function memoryDir() {
  return join(dataDir(), "memory")
}

/**
 * Category ids reach a file path, so they are validated rather than escaped —
 * the alphabet in `isValidMemoryCategory` has no `.` and no separator, which
 * leaves nothing for a `../` to be built from.
 */
function memoryPath(category: string) {
  if (!isValidMemoryCategory(category)) {
    throw new Error(`Invalid memory category "${category}"`)
  }
  return join(memoryDir(), `${category}.md`)
}

async function writeAtomic(path: string, content: string) {
  await mkdir(memoryDir(), { recursive: true })
  const tmp = `${path}.${process.pid.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`
  await writeFile(tmp, content, "utf8")
  await rename(tmp, path)
}

/** Every category file, alphabetical, with the defaults' order honoured first. */
export async function readMemoryFiles(): Promise<MemoryFile[]> {
  let names: string[]
  try {
    names = await readdir(memoryDir())
  } catch {
    return []
  }
  const categories = names
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .filter(isValidMemoryCategory)

  const files = await Promise.all(
    categories.map(async (category): Promise<MemoryFile | null> => {
      try {
        const path = memoryPath(category)
        const [content, info] = await Promise.all([
          readFile(path, "utf8"),
          stat(path),
        ])
        return {
          category,
          title: memoryTitleFrom(category, content),
          content,
          updatedAt: info.mtimeMs,
          bytes: Buffer.byteLength(content, "utf8"),
        }
      } catch {
        return null
      }
    })
  )

  const order = DEFAULT_MEMORY_CATEGORIES.map((entry) => entry.category)
  return files
    .filter((file): file is MemoryFile => file !== null)
    .sort((a, b) => {
      const rankA = order.indexOf(a.category)
      const rankB = order.indexOf(b.category)
      if (rankA !== rankB) {
        return (rankA < 0 ? order.length : rankA) - (rankB < 0 ? order.length : rankB)
      }
      return a.category.localeCompare(b.category)
    })
}

export async function readMemoryFile(category: string): Promise<string> {
  try {
    return await readFile(memoryPath(category), "utf8")
  } catch {
    return ""
  }
}

/**
 * Writes a category. Blank content deletes it, so clearing the editor (or an
 * extraction pass that emptied a category) removes the file rather than
 * leaving an empty one behind.
 *
 * A file with only a heading and no facts is kept: that is a category the user
 * has just created and is about to fill, and `memoryPromptBlock` skips it, so
 * it costs a turn nothing.
 */
export async function writeMemoryFile(category: string, content: string) {
  const trimmed = content.trim()
  if (!trimmed) {
    await deleteMemoryFile(category)
    return
  }
  await writeAtomic(memoryPath(category), `${trimmed}\n`)
}

export async function deleteMemoryFile(category: string) {
  await rm(memoryPath(category), { force: true })
}

export async function clearMemory() {
  await rm(memoryDir(), { recursive: true, force: true })
}

/**
 * The block handed to the agent for a turn: every fact, under its category
 * heading, trimmed to `budget` characters.
 *
 * Everything fits by design — the whole store is capped at a couple of
 * thousand characters — so there is no retrieval step and nothing to rank.
 * The trim here is a backstop for a hand-edited file that blew past the cap,
 * and it drops whole categories from the end rather than truncating a fact
 * into a half-sentence the model would read as fact.
 */
export function memoryPromptBlock(files: MemoryFile[], budget: number): string {
  const sections: string[] = []
  let used = 0
  for (const file of files) {
    const lines = memoryFactLines(file.content).filter(
      (line) => !line.startsWith("#")
    )
    if (lines.length === 0) continue
    const section = `## ${file.title}\n${lines.join("\n")}`
    if (used + section.length > budget) continue
    used += section.length + 2
    sections.push(section)
  }
  return sections.join("\n\n")
}

/** Total characters the store currently holds, for the budget check. */
export function memoryBytes(files: MemoryFile[]) {
  return files.reduce(
    (total, file) => total + memoryFactLines(file.content).join("\n").length,
    0
  )
}
