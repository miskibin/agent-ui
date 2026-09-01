import { NextResponse } from "next/server"

import { extractMemory } from "@/lib/memory/extract"
import { memoryBytes, readMemoryFiles } from "@/lib/memory/server"
import { readSettings } from "@/lib/settings/server"
import { getSession, readMessages } from "@/lib/store/sessions"

export const runtime = "nodejs"
// The extraction is a second, small model call; it never streams and never
// needs the chat route's full budget.
export const maxDuration = 60
export const dynamic = "force-dynamic"

/**
 * Runs one extraction pass over a thread and reports what changed.
 *
 * This is deliberately its own request rather than a tail on `/api/chat`: the
 * turn is already delivered and persisted by the time this fires, so a slow
 * local model, an Ollama restart or a hung request costs the user nothing but
 * a toast that resolves to "couldn't update". The chat stream is never held
 * open waiting for it.
 */
export async function POST(req: Request) {
  let body: { sessionId?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const sessionId = body.sessionId?.trim()
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 })
  }

  const settings = await readSettings()
  if (!settings.memory.enabled) {
    return NextResponse.json({ changes: [], skipped: "disabled" })
  }

  const session = await getSession(sessionId)
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 })
  }

  const messages = await readMessages(sessionId)
  /**
   * Only what the person typed. Assistant text, tool calls and tool output are
   * filtered out here, at the source, and this is the whole containment story
   * for the feature: a file the agent read, or an answer it wrote, cannot put
   * a line into a store that is pasted into every later conversation.
   */
  const userMessages = messages
    .filter((message) => message.sender === "user")
    .map((message) => message.content)

  const result = await extractMemory({
    settings: settings.memory,
    ollamaBaseUrl: settings.providers.ollama.baseUrl,
    userMessages,
    signal: req.signal,
  })

  const files = await readMemoryFiles()
  return NextResponse.json({ ...result, bytes: memoryBytes(files) })
}
