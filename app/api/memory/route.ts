import { NextResponse } from "next/server"

import {
  clearMemory,
  deleteMemoryFile,
  memoryStore,
  writeMemoryFile,
} from "@/lib/memory/server"
import { isValidMemoryName } from "@/lib/memory/types"
import { crossOriginRefusal } from "@/lib/request-origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The memory store as the settings page sees it. */
export async function GET() {
  return NextResponse.json(await memoryStore())
}

/**
 * Writes one file from the settings editor, under the same limits the agent's
 * `memory_write` is held to. `previousName` renames: the new file is written
 * first and the old one dropped only after, so a refused write loses nothing.
 */
export async function PUT(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  let body: { name?: string; description?: string; content?: string; previousName?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const name = body.name?.trim().toLowerCase() ?? ""
  const previous = body.previousName?.trim().toLowerCase()
  try {
    if (previous && previous !== name) {
      if (!isValidMemoryName(previous)) throw new Error("Invalid file name")
      if ((await memoryStore()).files.some((file) => file.name === name)) {
        throw new Error(`"${name}" already exists — merge the two by hand instead.`)
      }
      // Renaming must not trip the file cap on its way through.
      const content = body.content ?? ""
      const description = body.description ?? ""
      await deleteMemoryFile(previous)
      try {
        await writeMemoryFile({ name, description, content })
      } catch (err) {
        await writeMemoryFile({ name: previous, description, content }).catch(() => undefined)
        throw err
      }
    } else {
      await writeMemoryFile({
        name,
        description: body.description ?? "",
        content: body.content ?? "",
      })
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't save memory" },
      { status: 400 }
    )
  }
  return NextResponse.json(await memoryStore())
}

/** `?name=x` drops one file; no query at all wipes the whole store. */
export async function DELETE(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const name = new URL(req.url).searchParams.get("name")?.trim().toLowerCase()
  if (!name) {
    await clearMemory()
  } else if (!isValidMemoryName(name)) {
    return NextResponse.json({ error: "Invalid file name" }, { status: 400 })
  } else {
    await deleteMemoryFile(name)
  }
  return NextResponse.json(await memoryStore())
}
