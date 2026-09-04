import { NextResponse } from "next/server"

import { canComplete, complete } from "@/lib/completion"
import { crossOriginRefusal } from "@/lib/request-origin"
import { readSettings } from "@/lib/settings/server"
import { getSession, patchSession, readMessages } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** Enough of the thread to name it; the whole transcript would be waste. */
const MAX_CONTEXT_CHARS = 6_000
const MAX_TITLE_CHARS = 60

const SYSTEM = [
  "You name chat conversations.",
  "Reply with a title of at most six words that says what the conversation is about.",
  "No quotes, no trailing period, no preamble — the title only.",
].join(" ")

/**
 * `POST /api/sessions/<id>/title` — asks a model for a title and stores it.
 *
 * The chat's own model is used when it is one the app can reach directly (a
 * composite `<source>/<model>` id from Ollama or a configured provider);
 * a CLI harness's model is not, so the memory extractor's Ollama model is the
 * fallback. Nothing to ask → 409, and the title is left alone.
 */
export async function POST(req: Request, ctx: Ctx) {
  // A model call on the user's key, from a page on another origin — no.
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 })
  }
  const messages = await readMessages(id)
  const transcript = messages
    .filter((message) => !message.internal && message.content.trim())
    .map(
      (message) =>
        `${message.sender === "user" ? "User" : "Assistant"}: ${message.content
          .replace(/\s+/g, " ")
          .slice(0, 1_200)}`
    )
    .join("\n")
    .slice(0, MAX_CONTEXT_CHARS)
  if (!transcript) {
    return NextResponse.json(
      { error: "Nothing has been said in this chat yet" },
      { status: 409 }
    )
  }

  const settings = await readSettings()
  const candidates = [session.model, settings.memory.model].filter(
    (model): model is string => !!model && canComplete(settings, model)
  )
  const model = candidates[0]
  if (!model) {
    return NextResponse.json(
      {
        error:
          "No model to ask — pick an Ollama or hosted model for this chat, or set a memory model in Settings",
      },
      { status: 409 }
    )
  }

  let title: string
  try {
    title = await complete(settings, model, [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Conversation:\n\n${transcript}\n\nTitle:` },
    ])
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not generate a title"
    return NextResponse.json({ error: message }, { status: 502 })
  }
  const cleaned = title
    .split("\n")[0]
    .replace(/^["'“”‘’\s]+|["'“”‘’\s.]+$/g, "")
    .replace(/^title:\s*/i, "")
    .trim()
    .slice(0, MAX_TITLE_CHARS)
  if (!cleaned) {
    return NextResponse.json(
      { error: "The model returned an empty title" },
      { status: 502 }
    )
  }
  const updated = await patchSession(id, { title: cleaned })
  return NextResponse.json({ session: updated, title: cleaned })
}
