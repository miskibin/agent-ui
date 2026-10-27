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
import { memoryStatus } from "@/lib/memory/status"
import { crossOriginRefusal } from "@/lib/request-origin"
import { readSettings } from "@/lib/settings/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The memory store as the settings page sees it: the files, and whether memory
 * can run (`memoryStatus`).
 *
 * `?probe=1` asks as if memory were on, and is what the page sends while its
 * own switch is on. The page holds that switch live and saves it on a
 * debounce, so settings.json may not say "on" yet — and checking only then
 * would leave a fresh "on" showing nothing until the next reload. Probing
 * starts Ollama and the embedding model's download when they are missing, so
 * a page with memory off never sends it: looking at settings must not pull a
 * model.
 */
export async function GET(req: Request) {
  const probe = new URL(req.url).searchParams.get("probe") === "1"
  const settings = await readSettings()
  const files = await readMemoryFiles()
  return NextResponse.json({
    dir: memoryDir(),
    files,
    bytes: memoryBytes(files),
    status: await memoryStatus({
      ...settings,
      memory: { ...settings.memory, enabled: probe },
    }),
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
