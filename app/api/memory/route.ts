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
import { crossOriginRefusal } from "@/lib/request-origin"
import { readSettings } from "@/lib/settings/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The memory store as the settings page sees it: the files, and the state of
 * the Ollama server behind the extraction step.
 *
 * Deliberately no "is this feature working" verdict. Whether it is enabled and
 * which model it uses are settings the page holds live and saves on a debounce,
 * so a verdict computed here from settings.json would describe the state from
 * before the user's last click. The page composes the reason itself; the only
 * thing it cannot know without asking is whether Ollama answers.
 */
export async function GET() {
  const settings = await readSettings()
  const files = await readMemoryFiles()
  const baseUrl = normalizeBaseUrl(settings.providers.ollama.baseUrl)

  return NextResponse.json({
    dir: memoryDir(),
    files,
    bytes: memoryBytes(files),
    ollamaEnabled: settings.providers.ollama.enabled,
    ollamaBaseUrl: baseUrl,
    ollamaReachable: Boolean(baseUrl) && (await probeOllama(baseUrl)),
  })
}

/** Writes one category from the settings editor. Empty content removes it. */
export async function PUT(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
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
  const refused = crossOriginRefusal(req)
  if (refused) return refused
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
