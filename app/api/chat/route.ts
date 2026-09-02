import { NextResponse } from "next/server"

import type { MessageAttachmentData } from "@/components/ui/message"
import { base64FromDataUrl, sanitizeAttachments } from "@/lib/attachments"
import type { AgentTokenUsage } from "@/lib/cursor-agent-types"
import { createToolJournal, userJournalText } from "@/lib/handoff/journal"
import { commitTurn, prepareTurn } from "@/lib/handoff/server"
import type {
  AgentSessionState,
  NewJournalEvent,
  TurnStateFrame,
} from "@/lib/handoff/types"
import { buildMemoryContext } from "@/lib/memory/context"
import { getProvider } from "@/lib/providers/registry"
import type {
  AgentStreamEvent,
  ChatTurn,
  PermissionMode,
} from "@/lib/providers/types"
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

const MAX_REPLAY_MESSAGES = 200
const MAX_REPLAY_CHARACTERS = 512_000
const MAX_REPLAY_IMAGE_CHARACTERS = 16 * 1024 * 1024

type ChatBody = {
  prompt?: string
  providerId?: string
  model?: string
  /** App session id — the thread in `lib/store`, not the provider's own id. */
  sessionId?: string
  effort?: string
  /**
   * How much the harness may touch this turn; falls back to the chat's stored
   * mode, and is dropped entirely unless the provider publishes it.
   */
  permissionMode?: string
  /** Working folder for this run; falls back to the chat's stored folder. */
  cwd?: string
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

  await writeMessages(sessionId, [...prior, userMessage], {
    providerId,
    model,
    ...(shouldTitle ? { title: deriveSessionTitle(prompt) } : null),
  })

  // Providers that resume server-side get the id; stateless ones get the
  // transcript replayed instead — images included, so a vision model keeps
  // seeing what was attached earlier in the thread.
  const history: ChatTurn[] | undefined = info.capabilities.resume
    ? undefined
    : replayHistory(prior, info.capabilities.vision)

  const startedAt = Date.now()
  let assistant = seedAssistantMessage(body.assistantMessageId || newId())
  let durationMs: number | undefined
  let usage: AgentTokenUsage | undefined
  const cwd = body.cwd?.trim() || session.cwd

  /**
   * The backend session this provider owns in this chat, plus whatever the
   * *other* agents did while it was away.
   *
   * A stored id is no longer thrown away when the composer switches provider:
   * each backend keeps its own conversation, and the one coming back is told
   * what it missed instead of being handed a transcript it cannot explain.
   */
  const prepared = await prepareTurn({
    session,
    providerId,
    cwd,
    canResume: info.capabilities.resume,
    enabled: settings.handoff.enabled,
  })
  let providerSessionId = prepared.resumeSessionId
  // Like `cwd`: the turn's own choice, else what the chat last stored — and
  // only when this backend actually publishes the mode, so a client that
  // never sends one (or sends a mode this harness cannot enforce) leaves the
  // provider on its configured policy exactly as before.
  const permissionMode = allowedPermissionMode(
    info.capabilities.permissionModes,
    body.permissionMode?.trim() || session.permissionMode
  )

  /**
   * Standing user memory for this turn, when the feature is on.
   *
   * Backends that resume server-side get it only on the first turn of their
   * conversation: they already hold everything sent before, so re-sending the
   * block every turn would stack copies of it in their own transcript. The
   * stateless ones have their history replayed anyway, so they get it each
   * time. Either way it never touches `userMessage` — what the user typed is
   * what gets stored and shown.
   */
  const memoryContext =
    info.capabilities.resume && prepared.resumeSessionId
      ? undefined
      : await buildMemoryContext(settings, {
          toolCapable: info.capabilities.tools,
        })

  const abort = new AbortController()
  const onClientGone = () => abort.abort()
  req.signal.addEventListener("abort", onClientGone)

  /**
   * The turn's semantic events, for the next agent to arrive. Text, thinking
   * and tool output are deliberately absent: the journal is the summary a
   * returning agent needs, not a second transcript. Tool calls are keyed by
   * id because every harness reports one twice — the terminal state wins.
   */
  const toolJournal = createToolJournal()
  let sawError = false
  /**
   * Whether the backend actually took the prompt. `status` lines are the app
   * narrating a spawn, and a first event of `error` is the spawn failing — in
   * neither case has the agent seen the handoff, so the cursor must not move.
   */
  let runStarted = false

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      const send = (event: AgentStreamEvent | TurnStateFrame) => {
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
          standingContext: memoryContext,
          turnContext: prepared.handoff?.text,
          sessionId: providerSessionId,
          effort: info.capabilities.effort ? body.effort : undefined,
          permissionMode,
          cwd,
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
            usage = event.usage
          }
          if (event.type === "error") sawError = true
          if (event.type !== "status" && event.type !== "error") {
            runStarted = true
          }
          if (event.type === "tool") toolJournal.record(event)
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
        const state = await persist()
        // An app-level frame, not an `AgentStreamEvent`: the marker and the
        // composer's per-agent hints are this app's own concern, and the
        // vendored protocol has no business growing a variant for them.
        // `lib/api-client` routes it away from the stream reducer.
        if (state) send(state)
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

  /**
   * Saves whatever the turn produced — including a stopped partial answer —
   * and hands back the app-level frame that tells the client what the turn
   * was sent and which agents now hold a session in this chat.
   */
  async function persist(): Promise<TurnStateFrame | undefined> {
    const elapsed = (durationMs ?? Date.now() - startedAt) / 1000
    const outcome = abort.signal.aborted
      ? "aborted"
      : sawError
        ? "error"
        : "ok"
    const journalEvents: NewJournalEvent[] = [
      { kind: "user-message", providerId, text: userJournalText(userMessage.content) },
      ...toolJournal.events().map(
        (tool): NewJournalEvent => ({ kind: "tool", providerId, ...tool })
      ),
      {
        kind: "turn-end",
        providerId,
        model,
        outcome,
        ...(outcome === "error" && assistantError(assistant)
          ? { error: assistantError(assistant) as string }
          : null),
      },
    ]

    let agentSessions: Record<string, AgentSessionState> | undefined
    try {
      agentSessions = await commitTurn({
        sessionId: sessionId!,
        providerId,
        cwd,
        prepared,
        events: journalEvents,
        runStarted,
        providerSessionId,
        enabled: settings.handoff.enabled,
      })
    } catch {
      /* the answer is delivered; per-agent bookkeeping is not worth a 500 */
    }

    const finished: StoredMessage = {
      ...assistant,
      createdAt: Date.now(),
      workedFor: elapsed,
      metadata: {
        model,
        providerId,
        responseTime: elapsed,
        finishedAt: Date.now(),
        ...(cwd ? { cwd, gitBranch: session!.gitBranch } : null),
        ...tokenMetadata(usage),
        ...(prepared.handoff ? { handoff: prepared.handoff.marker } : null),
      },
    }
    const keep = finished.content.trim() || (finished.parts?.length ?? 0) > 0
    const patch: SessionPatch = {
      providerId,
      model,
      // Still written for the provider that ran, so an index read by an older
      // build (or by anything that only knows the single-id field) resumes
      // the same conversation `agentSessions` does.
      ...(providerSessionId ? { providerSessionId } : null),
      ...(agentSessions ? { agentSessions } : null),
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

    return {
      type: "turn-state",
      messageId: finished.id,
      ...(agentSessions ? { agentSessions } : null),
      ...(prepared.handoff ? { handoff: prepared.handoff.marker } : null),
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

/** Why a failed turn failed, for the journal — the reducer already wrote it. */
function assistantError(message: StoredMessage) {
  const match = /Agent error: (.+)/.exec(message.content)
  return match?.[1]?.trim() || undefined
}

/**
 * The requested permission mode, but only if this provider declared it. An
 * unknown or unsupported value is dropped rather than refused: the turn still
 * runs, under the harness's own policy.
 */
function allowedPermissionMode(
  offered: PermissionMode[] | undefined,
  wanted: string | undefined
): PermissionMode | undefined {
  const mode = wanted?.trim()
  if (!mode) return undefined
  return (offered ?? []).includes(mode as PermissionMode)
    ? (mode as PermissionMode)
    : undefined
}

/**
 * Durable history and model context are separate budgets. Stateless providers
 * get the newest useful window instead of serializing an unbounded transcript
 * (and every historical base64 image) into each new request.
 */
function replayHistory(messages: StoredMessage[], vision: boolean): ChatTurn[] {
  const selected: ChatTurn[] = []
  let characters = 0
  let imageCharacters = 0

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message.content.trim() && !message.attachments?.length) continue
    if (selected.length >= MAX_REPLAY_MESSAGES) break
    if (
      selected.length > 0 &&
      characters + message.content.length > MAX_REPLAY_CHARACTERS
    ) {
      break
    }

    const images: string[] = []
    if (vision) {
      for (const attachment of message.attachments ?? []) {
        const image = base64FromDataUrl(attachment.url)
        if (imageCharacters + image.length > MAX_REPLAY_IMAGE_CHARACTERS) break
        imageCharacters += image.length
        images.push(image)
      }
    }

    characters += message.content.length
    selected.push({
      role: message.sender === "user" ? "user" : "assistant",
      content: message.content,
      ...(images.length ? { images } : null),
    })
  }

  selected.reverse()
  while (selected[0]?.role === "assistant") selected.shift()
  return selected
}

/** Only the counters the backend actually reported make it into the record. */
function tokenMetadata(usage: AgentTokenUsage | undefined) {
  if (!usage) return null
  const { input, output, tokensPerSecond } = usage
  return {
    ...(input == null ? null : { inputTokens: input }),
    ...(output == null ? null : { outputTokens: output }),
    ...(tokensPerSecond == null ? null : { tokensPerSecond }),
    ...(input == null && output == null
      ? null
      : { tokens: (input ?? 0) + (output ?? 0) }),
  }
}
