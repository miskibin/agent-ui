import { NextResponse } from "next/server"

import type { MessageAttachmentData } from "@/components/ui/message"
import { base64FromDataUrl, sanitizeAttachments } from "@/lib/attachments"
import { getProvider } from "@/lib/providers/registry"
import type { AgentStreamEvent, ChatTurn } from "@/lib/providers/types"
import {
  applyStreamEvent,
  deriveSessionTitle,
  newId,
  seedAssistantMessage,
} from "@/lib/message-stream"
import { readSettings } from "@/lib/settings/server"
import { getSession, readMessages, writeMessages } from "@/lib/store/sessions"
import type { SessionPatch, StoredMessage } from "@/lib/store/types"

export const runtime = "nodejs"
// Vercel's hobby plan caps serverless maxDuration at 60s.
export const maxDuration = 60
export const dynamic = "force-dynamic"

type ChatBody = {
  prompt?: string
  providerId?: string
  model?: string
  /** App session id — the thread in `lib/store`, not the provider's own id. */
  sessionId?: string
  effort?: string
  /**
   * Ids minted by the client so its optimistic messages and the persisted
   * ones are the same rows. Absent ids are generated here.
   */
  userMessageId?: string
  assistantMessageId?: string
  attachments?: unknown
}

/**
 * Runs one turn: appends the user message, streams the provider's events
 * straight through as SSE, and folds the same events into the assistant
 * message that gets persisted when the run settles. The client renders from
 * the identical reducer (`lib/message-stream`), so a reload matches the live
 * stream exactly.
 */
export async function POST(req: Request) {
  let body: ChatBody
  try {
    body = (await req.json()) as ChatBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const prompt = body.prompt?.trim()
  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 })
  }

  const sessionId = body.sessionId?.trim()
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 })
  }
  const session = await getSession(sessionId)
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 })
  }

  const providerId = body.providerId?.trim() || session.providerId
  const provider = await getProvider(providerId)
  if (!provider) {
    return NextResponse.json(
      { error: `Unknown or disabled provider "${providerId}"` },
      { status: 400 }
    )
  }
  const info = await provider.info()
  if (!info.available) {
    return NextResponse.json(
      { error: info.unavailableReason ?? `${info.name} is unavailable` },
      { status: 503 }
    )
  }

  const model = body.model?.trim() || session.model
  const settings = await readSettings()
  const prior = await readMessages(sessionId)
  const attachments: MessageAttachmentData[] = sanitizeAttachments(
    body.attachments
  )

  const userMessage: StoredMessage = {
    id: body.userMessageId || newId(),
    content: prompt,
    sender: "user",
    createdAt: Date.now(),
    ...(attachments.length ? { attachments } : null),
  }

  const shouldTitle =
    settings.chat.autoTitle &&
    prior.length === 0 &&
    (!session.title || session.title === "New chat")

  // The stored provider session id belongs to whichever backend produced it.
  // Handing it to a *different* provider after a mid-session switch would
  // resume a conversation that backend never started.
  const providerChanged = session.providerId !== providerId

  await writeMessages(sessionId, [...prior, userMessage], {
    providerId,
    model,
    ...(providerChanged ? { providerSessionId: "" } : null),
    ...(shouldTitle ? { title: deriveSessionTitle(prompt) } : null),
  })

  // Providers that resume server-side get the id; stateless ones get the
  // transcript replayed instead — images included, so a vision model keeps
  // seeing what was attached earlier in the thread.
  const history: ChatTurn[] | undefined = info.capabilities.resume
    ? undefined
    : prior
        .filter(
          (message) =>
            message.content.trim().length > 0 ||
            (message.attachments?.length ?? 0) > 0
        )
        .map((message) => ({
          role: message.sender === "user" ? ("user" as const) : ("assistant" as const),
          content: message.content,
          ...(info.capabilities.vision && message.attachments?.length
            ? { images: message.attachments.map((a) => base64FromDataUrl(a.url)) }
            : null),
        }))

  const startedAt = Date.now()
  let assistant = seedAssistantMessage(body.assistantMessageId || newId())
  let providerSessionId = providerChanged ? undefined : session.providerSessionId
  let durationMs: number | undefined

  const abort = new AbortController()
  const onClientGone = () => abort.abort()
  req.signal.addEventListener("abort", onClientGone)

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      const send = (event: AgentStreamEvent) => {
        if (closed) return
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          )
        } catch {
          closed = true
        }
      }

      try {
        for await (const event of provider.run({
          prompt,
          model,
          sessionId: providerSessionId,
          effort: info.capabilities.effort ? body.effort : undefined,
          history,
          images: info.capabilities.vision
            ? attachments.map((a) => base64FromDataUrl(a.url))
            : undefined,
          signal: abort.signal,
        })) {
          if (event.type === "session") providerSessionId = event.sessionId
          if (event.type === "done") {
            providerSessionId = event.sessionId ?? providerSessionId
            durationMs = event.durationMs
          }
          assistant = applyStreamEvent(assistant, event)
          send(event)
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : `${info.name} failed`,
          })
        }
      } finally {
        req.signal.removeEventListener("abort", onClientGone)
        await persist()
        if (!closed) {
          try {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          } catch {
            /* client already gone */
          }
        }
        controller.close()
      }
    },
    cancel() {
      abort.abort()
    },
  })

  /** Saves whatever the turn produced — including a stopped partial answer. */
  async function persist() {
    const elapsed = (durationMs ?? Date.now() - startedAt) / 1000
    const finished: StoredMessage = {
      ...assistant,
      createdAt: Date.now(),
      workedFor: elapsed,
      metadata: { model, providerId, responseTime: elapsed },
    }
    const keep = finished.content.trim() || (finished.parts?.length ?? 0) > 0
    const patch: SessionPatch = {
      providerId,
      model,
      ...(providerSessionId ? { providerSessionId } : null),
    }
    try {
      await writeMessages(
        sessionId!,
        keep ? [...prior, userMessage, finished] : [...prior, userMessage],
        patch
      )
    } catch {
      /* the turn already streamed; a failed write must not crash the route */
    }
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
