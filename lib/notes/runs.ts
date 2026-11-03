import "server-only"

import { randomBytes } from "node:crypto"

import { newId } from "@/lib/message-stream"
import { clearPending, getNoteMeta, notesDir, readNote, setNoteAgent, updateThreads } from "@/lib/notes/server"
import type { NoteThread, NoteThreadMessage } from "@/lib/notes/types"
import { createSession, getSession } from "@/lib/store/sessions"

/**
 * One ask from a note, end to end: the thread it lives in, the turn that
 * answers it, and the reply that closes it.
 *
 * The turn is an ordinary chat turn, driven through this server's own
 * `POST /api/chat` exactly as the subagent runner drives one — so the
 * harness, its resume, its permission handling and the transcript are the
 * chat route's, and nothing is written twice. The chat is the note's own
 * hidden one (`SessionMeta.noteId`), which the route recognises: it hands the
 * agent the `note_*` tools on the bridge and nothing else.
 *
 * One ask runs at a time per note; the rest wait their turn, because two
 * agents rewriting one note at once is a race neither the person nor the
 * guard can follow.
 */

type ActiveRun = { threadId: string; abort: AbortController }

type State = {
  queues: Map<string, Promise<void>>
  active: Map<string, ActiveRun>
}

const globalState = globalThis as typeof globalThis & { __agentUiNoteRuns?: State }
const state: State = (globalState.__agentUiNoteRuns ??= { queues: new Map(), active: new Map() })

const MAX_ANCHOR_CHARS = 4000
const MAX_REPLY_CHARS = 2000

export type AskInput = {
  origin: string
  noteId: string
  /** A follow-up in an existing thread; absent starts one on `anchor`. */
  threadId?: string
  anchor?: string
  instruction: string
  providerId: string
  model: string
  effort?: string
}

function newThreadId() {
  return `t${randomBytes(6).toString("hex")}`
}

function message(author: NoteThreadMessage["author"], text: string, error?: boolean): NoteThreadMessage {
  return { id: newId(), author, text, at: Date.now(), ...(error ? { error: true } : null) }
}

function setThread(noteId: string, threadId: string, change: (thread: NoteThread) => NoteThread) {
  return updateThreads(noteId, (threads) => ({
    threads: threads.map((thread) => (thread.id === threadId ? change(thread) : thread)),
    value: undefined,
  }))
}

/** The prompt a note ask sends: the request, the words it is about, and how to work. */
export function notePrompt(input: {
  title: string
  anchor: string
  instruction: string
  earlier: NoteThreadMessage[]
}) {
  const earlier = input.earlier.length
    ? `\nEarlier in this thread:\n${input.earlier
        .map((entry) => `${entry.author === "user" ? "Person" : "You"}: ${entry.text}`)
        .join("\n")}\n`
    : ""
  return `The person selected words in the note "${input.title}" and asked:

${input.instruction}

The selected words:
"""
${input.anchor.slice(0, MAX_ANCHOR_CHARS)}
"""
${earlier}
How to work:
- Use only the note tools: note_read first (it gives block ids), then note_edit. Do not edit files on disk.
- Change only what was asked; every other word stays, and so does the note's language and tone.
- For anything longer than a sentence, first plant a pending placeholder where it will land (op "pending" with a short intent), then replace it with the content.
- Shape the content: a flow, an architecture or a sequence is a \`\`\`mermaid diagram; a comparison is a table; a formula is $…$ or $$…$$.
- If an edit is refused because a block changed, read again and work from what stands now.
- If this is a question rather than a change, answer it without editing.

Your final message is the reply in the comment thread beside the note: one or two short sentences saying what you changed (not the content again), or the answer.`
}

/** Starts an ask (or queues it behind the one running) and returns its thread id. */
export async function askNote(input: AskInput): Promise<string> {
  const meta = await getNoteMeta(input.noteId)
  if (!meta) throw new Error("No such note.")
  const instruction = input.instruction.trim()
  if (!instruction) throw new Error("Say what the agent should do.")

  const threadId = input.threadId ?? newThreadId()
  const now = Date.now()
  const created = await updateThreads(input.noteId, (threads) => {
    const existing = threads.find((thread) => thread.id === threadId)
    if (input.threadId && !existing) return { threads, value: false }
    const userMessage = message("user", instruction)
    const next: NoteThread = existing
      ? { ...existing, status: "queued", resolved: false, updatedAt: now, messages: [...existing.messages, userMessage] }
      : {
          id: threadId,
          anchor: (input.anchor ?? "").slice(0, MAX_ANCHOR_CHARS),
          status: "queued",
          createdAt: now,
          updatedAt: now,
          messages: [userMessage],
        }
    return {
      threads: existing ? threads.map((thread) => (thread.id === threadId ? next : thread)) : [...threads, next],
      value: true,
    }
  })
  if (!created) throw new Error("No such thread.")

  const previous = state.queues.get(input.noteId) ?? Promise.resolve()
  const run = previous.then(() => runAsk({ ...input, threadId, instruction }))
  const settled = run.catch(() => undefined)
  state.queues.set(input.noteId, settled)
  void settled.then(() => {
    if (state.queues.get(input.noteId) === settled) state.queues.delete(input.noteId)
  })
  return threadId
}

/** Stops the ask running on a note, if any. */
export function cancelNoteAsk(noteId: string, threadId?: string) {
  const active = state.active.get(noteId)
  if (!active || (threadId && active.threadId !== threadId)) return false
  active.abort.abort()
  return true
}

export function activeNoteAsk(noteId: string) {
  return state.active.get(noteId)?.threadId
}

async function ensureChat(input: AskInput & { title: string }) {
  const meta = await getNoteMeta(input.noteId)
  const existing = meta?.chatId ? await getSession(meta.chatId) : null
  if (existing) return existing.id
  const session = await createSession({
    title: `Note: ${input.title}`,
    providerId: input.providerId,
    model: input.model,
    cwd: notesDir(),
    permissionMode: "read-only",
    noteId: input.noteId,
  })
  await setNoteAgent(input.noteId, { chatId: session.id })
  return session.id
}

type StreamEvent = { type?: string; text?: string; message?: string }

async function runAsk(input: AskInput & { threadId: string; instruction: string }) {
  const abort = new AbortController()
  state.active.set(input.noteId, { threadId: input.threadId, abort })
  const segments: string[] = [""]
  let failure: string | undefined
  try {
    const note = await readNote(input.noteId)
    if (!note) throw new Error("The note was deleted.")
    const threads = await updateThreads(input.noteId, (all) => {
      const next = all.map((thread) =>
        thread.id === input.threadId && thread.status !== "cancelled"
          ? { ...thread, status: "running" as const, updatedAt: Date.now() }
          : thread
      )
      return { threads: next, value: next }
    })
    const thread = threads.find((entry) => entry.id === input.threadId)
    if (!thread || thread.status !== "running") return
    const chatId = await ensureChat({ ...input, title: note.meta.title })
    await setNoteAgent(input.noteId, { chatId, providerId: input.providerId, model: input.model })

    const res = await fetch(new URL("/api/chat", input.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: notePrompt({
          title: note.meta.title,
          anchor: thread.anchor,
          instruction: input.instruction,
          earlier: thread.messages.slice(0, -1).slice(-6),
        }),
        typedText: input.instruction,
        providerId: input.providerId,
        model: input.model,
        effort: input.effort,
        sessionId: chatId,
        cwd: notesDir(),
        permissionMode: "read-only",
      }),
      signal: abort.signal,
    })
    if (!res.ok || !res.body) {
      let text = `The chat route answered ${res.status}`
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) text = body.error
      } catch {
        /* keep the status line */
      }
      throw new Error(text)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const handle = (data: string) => {
      if (!data || data === "[DONE]") return
      let event: StreamEvent
      try {
        event = JSON.parse(data) as StreamEvent
      } catch {
        return
      }
      if (event.type === "text" && event.text) segments[segments.length - 1] += event.text
      // What the agent says after its last tool call is its reply; what it
      // said on the way there is narration.
      else if (event.type === "tool" && segments.at(-1)?.trim()) segments.push("")
      else if (event.type === "error") failure = event.message || "The agent failed."
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        handle(
          frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
            .trim()
        )
        boundary = buffer.indexOf("\n\n")
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) failure = err instanceof Error ? err.message : String(err)
  } finally {
    if (state.active.get(input.noteId)?.abort === abort) state.active.delete(input.noteId)
    await clearPending(input.noteId).catch(() => undefined)
    const reply = (segments.filter((part) => part.trim()).at(-1) ?? "").trim().slice(0, MAX_REPLY_CHARS)
    const cancelled = abort.signal.aborted
    await setThread(input.noteId, input.threadId, (thread) => ({
      ...thread,
      status: cancelled ? "cancelled" : failure ? "error" : "done",
      updatedAt: Date.now(),
      messages: [
        ...thread.messages,
        ...(cancelled
          ? [message("agent", "Stopped.")]
          : failure
            ? [message("agent", failure, true)]
            : [message("agent", reply || "Done.")]),
      ],
    })).catch(() => undefined)
  }
}
