import "server-only"

import type { AppSettings } from "@/lib/settings/schema"
import { renderMemoryContext, type MemoryAccess } from "@/lib/memory/prompt"
import { memoryDir, readMemoryFiles } from "@/lib/memory/server"

/**
 * Builds the memory block for one turn, or undefined for none. Nothing here
 * runs a model: reading a dozen small files is the whole cost, so memory is
 * never "down" the way the old Ollama extractor could be.
 */
export async function buildMemoryContext(
  settings: AppSettings,
  options: { access: MemoryAccess }
): Promise<string | undefined> {
  if (!settings.memory.enabled) return undefined
  return renderMemoryContext({
    files: await readMemoryFiles(),
    budget: settings.memory.maxChars,
    access: options.access,
    dir: memoryDir(),
  })
}
