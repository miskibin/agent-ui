import { NextResponse } from "next/server"

import { canComplete, complete, sanitizeTitle } from "@/lib/completion"
import { crossOriginRefusal } from "@/lib/request-origin"
import { readSettings } from "@/lib/settings/server"
import { getSession, patchSession, readMessages } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** Enough of the thread to name it; the whole transcript would be waste. */
const MAX_CONTEXT_CHARS = 6_000
/** The placeholder a chat is born with — not a previous title to improve on. */
const PLACEHOLDER_TITLE = "New chat"

/**
 * Rules both prompts share.
 *
 * Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License,
 * (c) 2026 T3 Tools Inc.
 *
 * The one that earns its place is the third: a request is mostly instructions
 * about *how* to work, and a model handed "using pytest, write me a parser and
 * show the output as a table" will happily title the chat "Pytest Table
 * Output". The subject is the parser. Naming what the thread is *about*, and
 * throwing away how it was to be done, is the whole difference between a
 * sidebar you can scan and one you have to open.
 */
const SHARED_RULES = [
  "- 3-8 words, under 40 characters.",
  "- A compact noun phrase or a clear action phrase.",
  "- Name the subject and the outcome, never the incidental instructions.",
  "- Models, tools, output formats and process instructions do not belong in the title unless they are themselves the topic.",
  "- Name the change itself, not the plan, report, branch or PR used to produce it.",
  "- Capture the umbrella goal when the request lists several symptoms or steps.",
  "- For a review, name what is reviewed and the concern, not one finding.",
  "- Do not claim the work is finished.",
  "- Do not copy and truncate a message from the thread.",
  "- No quotes, no labels, no filler, no trailing punctuation.",
]

const INITIAL_PROMPT = [
  "Generate a title that helps the user recognize this chat weeks later.",
  'Reply with JSON with exactly one key: {"title": "…"}.',
  "",
  "Before answering, silently reduce the conversation to:",
  "- Subject: what system, feature or problem is this really about?",
  "- Outcome: what does the user ultimately want to understand or change?",
  "- Incidental instructions: what only describes how the work should be done?",
  "Title the subject and the outcome. Discard the incidental instructions.",
  "",
  "Rules:",
  ...SHARED_RULES,
].join("\n")

/**
 * Regeneration is a different question from naming: there is already a title,
 * and the answer has to be better rather than merely different. So the order
 * of evidence is spelled out — the user's messages decide the subject, the
 * assistant's only resolve what a vague one referred to — and the previous
 * title is kept when it is accurate, because a thread that has moved from
 * planning to review to CI has not changed what it is about.
 */
function regeneratePrompt(previousTitle: string) {
  return [
    "Regenerate the title of an existing chat so the user recognizes it weeks later.",
    `The previous title was ${JSON.stringify(previousTitle)}.`,
    'Reply with JSON with exactly one key: {"title": "…"}.',
    "",
    "Decide in this order:",
    "1. Read the user's messages. The latest durable goal is the subject; the original subject holds until the user clearly changes it.",
    "2. Use the assistant's messages only to resolve vague references. A finding is not a new subject unless the user adopts it as one.",
    "3. Keep the previous title's accurate scope words. Replace it when it is generic, artifact-based, a completion update, or contradicted by the thread.",
    "4. Title the durable subject, not the workflow state it has reached.",
    "",
    "Rules:",
    ...SHARED_RULES,
    "- A thread moving through research, planning, implementation, review and merge has usually not changed subject.",
    "- Return a meaningfully better title, not a paraphrase of the previous one.",
  ].join("\n")
}

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
  const candidates = [
    ...new Set(
      [session.model, settings.memory.model].filter(
        (model): model is string => !!model && canComplete(settings, model)
      )
    ),
  ]
  if (candidates.length === 0) {
    return NextResponse.json(
      {
        error:
          "No model to ask — pick an Ollama or hosted model for this chat, or set a memory model in Settings",
      },
      { status: 409 }
    )
  }

  // Naming a chat and re-naming one are different questions: the second has a
  // title to improve on, and improving one is not the same as inventing one.
  const previousTitle = session.title.trim()
  const system =
    previousTitle && previousTitle !== PLACEHOLDER_TITLE
      ? regeneratePrompt(previousTitle)
      : INITIAL_PROMPT

  /**
   * Every candidate, not just the first: a model that was configured once and
   * has since been deleted from the Ollama server answers 404, and falling
   * through to the next one is the difference between a renamed chat and a
   * naming feature that stays broken until the user finds the stale setting.
   */
  let title = ""
  let failure = ""
  for (const model of candidates) {
    try {
      title = await complete(settings, model, [
        { role: "system", content: system },
        { role: "user", content: `Conversation:\n\n${transcript}\n\nTitle:` },
      ])
      if (title.trim()) break
    } catch (err) {
      failure = err instanceof Error ? err.message : "Could not generate a title"
    }
  }
  if (!title.trim() && failure) {
    return NextResponse.json({ error: failure }, { status: 502 })
  }
  const cleaned = sanitizeTitle(title)
  if (!cleaned) {
    return NextResponse.json(
      { error: "The model returned an empty title" },
      { status: 502 }
    )
  }
  const updated = await patchSession(id, { title: cleaned })
  return NextResponse.json({ session: updated, title: cleaned })
}
