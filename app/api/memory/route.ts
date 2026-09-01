import { NextResponse } from "next/server"

import {
  clearMemory,
  deleteMemoryFile,
  memoryBytes,
  memoryDir,
  readMemoryFiles,
  writeMemoryFile,
} from "@/lib/memory/server"
import { isValidMemoryCategory } from "@/lib/memory/types"
import { normalizeBaseUrl, probeOllama } from "@/lib/providers/ollama-api"
import { readSettings } from "@/lib/settings/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The memory store as the settings page sees it: the files themselves, plus
 * why the feature is or is not doing anything. The reason matters more than
 * the usual availability flag here — memory that silently never updates
 * because Ollama is down looks identical to memory that has nothing to learn.
 */
export async function GET() {
  const settings = await readSettings()
  const files = await readMemoryFiles()
  const baseUrl = normalizeBaseUrl(settings.providers.ollama.baseUrl)

  let reason: string | undefined
  if (!settings.memory.enabled) reason = "Memory is off."
  else if (!settings.memory.model) reason = "No extraction model chosen."
  else if (!settings.providers.ollama.enabled) reason = "Ollama is disabled."
  else if (!baseUrl || !(await probeOllama(baseUrl))) {
    reason = `No Ollama server at ${baseUrl || "an unset URL"}.`
  }

  return NextResponse.json({
    dir: memoryDir(),
    files,
    bytes: memoryBytes(files),
    budget: settings.memory.maxChars,
    ready: reason === undefined,
    reason,
  })
}

/** Writes one category from the settings editor. Empty content removes it. */
export async function PUT(req: Request) {
  let body: { category?: string; content?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const category = body.category?.trim().toLowerCase() ?? ""
  if (!isValidMemoryCategory(category)) {
    return NextResponse.json(
      { error: "category must be lowercase letters, digits and dashes" },
      { status: 400 }
    )
  }

  await writeMemoryFile(category, body.content ?? "")
  const files = await readMemoryFiles()
  return NextResponse.json({ files, bytes: memoryBytes(files) })
}

/** `?category=x` drops one file; no query at all wipes the whole store. */
export async function DELETE(req: Request) {
  const category = new URL(req.url).searchParams.get("category")?.trim()
  if (!category) {
    await clearMemory()
    return NextResponse.json({ files: [], bytes: 0 })
  }
  if (!isValidMemoryCategory(category.toLowerCase())) {
    return NextResponse.json({ error: "Invalid category" }, { status: 400 })
  }
  await deleteMemoryFile(category.toLowerCase())
  const files = await readMemoryFiles()
  return NextResponse.json({ files, bytes: memoryBytes(files) })
}
