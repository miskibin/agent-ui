import "server-only"

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { dataDir } from "@/lib/settings/server"
import {
  isValidMemoryName,
  memoryWriteError,
  parseMemoryFile,
  serializeMemoryFile,
  type MemoryFile,
  type MemoryStore,
} from "@/lib/memory/types"

/**
 * The on-disk half of the memory layer: one markdown topic file per name under
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
 * Names reach a file path, so they are validated rather than escaped — the
 * alphabet in `isValidMemoryName` has no `.` and no separator, which leaves
 * nothing for a `../` to be built from.
 */
export function memoryPath(name: string) {
  if (!isValidMemoryName(name)) {
    throw new Error(`Invalid memory file name "${name}"`)
  }
  return join(memoryDir(), `${name}.md`)
}

async function writeAtomic(path: string, content: string) {
  await mkdir(memoryDir(), { recursive: true })
  const tmp = `${path}.${process.pid.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`
  await writeFile(tmp, content, "utf8")
  await rename(tmp, path)
}

/** Every topic file, most recently updated first. */
export async function readMemoryFiles(): Promise<MemoryFile[]> {
  let names: string[]
  try {
    names = await readdir(memoryDir())
  } catch {
    return []
  }
  const files = await Promise.all(
    names
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => entry.slice(0, -3))
      .filter(isValidMemoryName)
      .map(async (name): Promise<MemoryFile | null> => {
        try {
          const path = memoryPath(name)
          const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)])
          const parsed = parseMemoryFile(name, raw)
          return {
            name,
            ...parsed,
            updatedAt: info.mtimeMs,
            bytes: Buffer.byteLength(parsed.content, "utf8"),
          }
        } catch {
          return null
        }
      })
  )
  return files
    .filter((file): file is MemoryFile => file !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

export async function readMemoryFile(name: string): Promise<MemoryFile | undefined> {
  return (await readMemoryFiles()).find((file) => file.name === name)
}

/**
 * Creates or replaces one file, under the same limits whoever writes — the
 * agent through the MCP tool or the user through settings. Throws the reason
 * (`memoryWriteError`) when the write is refused.
 */
export async function writeMemoryFile(input: {
  name: string
  description: string
  content: string
}) {
  const existing = (await readMemoryFiles()).map((file) => file.name)
  const refused = memoryWriteError(input, existing)
  if (refused) throw new Error(refused)
  await writeAtomic(
    memoryPath(input.name),
    serializeMemoryFile(input.description, input.content)
  )
}

/** True when there was a file to delete. */
export async function deleteMemoryFile(name: string): Promise<boolean> {
  const path = memoryPath(name)
  const existed = await stat(path).then(
    () => true,
    () => false
  )
  await rm(path, { force: true })
  return existed
}

export async function clearMemory() {
  await rm(memoryDir(), { recursive: true, force: true })
}

export function memoryBytes(files: MemoryFile[]) {
  return files.reduce((total, file) => total + file.content.length, 0)
}

export async function memoryStore(): Promise<MemoryStore> {
  const files = await readMemoryFiles()
  return { dir: memoryDir(), files, bytes: memoryBytes(files) }
}
