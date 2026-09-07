"use client"

import * as React from "react"
import { toast } from "sonner"

import { isOpenAskTool } from "@/components/ui/ask-question"
import type { GenerationStage } from "@/components/ui/generation-status"
import type { MessageAttachmentData } from "@/components/ui/message"
import * as api from "@/lib/api-client"
import {
  errorMessage,
  folderMetadata,
  nowMs,
  omit,
  statusStage,
} from "@/lib/chat-helpers"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import type { TurnStateFrame } from "@/lib/handoff/types"
import { runLayoutTransition } from "@/lib/layout-transition"
import {
  applyStreamEvent,
  deriveSessionTitle,
  newId,
  seedAssistantMessage,
} from "@/lib/message-stream"
import { playAgentNotificationSound } from "@/lib/notification-sounds"
import { notifyAttention } from "@/lib/notifications"
import {
  isOpenUserRequestTool,
  parseUserRequestInput,
} from "@/lib/turn-requests"
import type { MemoryChange } from "@/lib/memory/types"
import type { PermissionMode } from "@/lib/providers/types"
import type {
  SessionMeta,
  StoredMessage,
  TurnCheckpoint,
} from "@/lib/store/types"

import type { SessionRun } from "./chat-types"
import type { ChatRefs } from "./use-chat-refs"

export type RunPromptArgs = {
  sessionId: string
  prompt: string
  prior: StoredMessage[]
  providerId: string
  model: string
  effort?: string
  permissionMode?: PermissionMode
  attachments?: MessageAttachmentData[]
  animate?: boolean
  titleFrom?: string
  /** What the user actually typed, when the prompt is more than that. */
  typedText?: string
  /** The app wrote this prompt, not the user — keep it out of the list. */
  internal?: boolean
  /**
   * Seed over `prior` instead of onto whatever the thread now holds — only
   * regenerate, which means to drop the turn it is re-running.
   */
  replacePrior?: boolean
}

export type RunPrompt = (args: RunPromptArgs) => Promise<void>

/**
 * A fire-and-forget POST that is allowed to fail. Module-level on purpose:
 * nothing the memoized rows are handed may close over a render.
 */
async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

/**
 * One agent turn, start to finish: seed the message pair, fold the stream into
 * the assistant message a frame at a time, keep the sidebar's Working label
 * honest, notify when the window is not in front, and clean up whatever
 * happens. Every chat runs independently — the abort controllers are keyed by
 * session id, so switching chats mid-turn never touches the one left behind.
 */
export function useTurnRunner({
  refs,
  setThreads,
  setRuns,
  setFailures,
  setMemoryNotices,
  patchLocal,
  runMemoryUpdate,
  notificationSounds,
}: {
  refs: ChatRefs
  setThreads: React.Dispatch<
    React.SetStateAction<Record<string, StoredMessage[]>>
  >
  setRuns: React.Dispatch<React.SetStateAction<Record<string, SessionRun>>>
  setFailures: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  setMemoryNotices: React.Dispatch<
    React.SetStateAction<
      Record<string, { changes: MemoryChange[]; compacted?: boolean }>
    >
  >
  patchLocal: (id: string, patch: Partial<SessionMeta>) => void
  runMemoryUpdate: (sessionId: string) => Promise<void>
  /** Passed unresolved, so the runner is not rebuilt when settings first land. */
  notificationSounds: boolean | undefined
}): RunPrompt {
  const { abortsRef, drainQueueRef, selectSessionRef, sessionsRef, settingsRef, threadsRef } =
    refs

  React.useEffect(() => {
    const aborts = abortsRef.current
    return () => {
      for (const controller of aborts.values()) controller.abort()
      aborts.clear()
    }
  }, [abortsRef])

  return React.useCallback<RunPrompt>(
    async (args) => {
      const { sessionId, prompt, prior } = args
      const startedAt = nowMs()
      const assistantId = newId()
      const userMessage: StoredMessage = {
        id: newId(),
        content: prompt,
        sender: "user",
        createdAt: startedAt,
        ...(args.internal ? { internal: true } : null),
        ...(args.attachments?.length ? { attachments: args.attachments } : null),
      }
      const assistantMessage = seedAssistantMessage(assistantId)
      /**
       * The pair is appended to what the thread *now* holds, not written over
       * `prior`: a queued message is sent from the ending turn's `finally`,
       * one paint before the mirrors catch up, so the `prior` it carries is
       * still missing the error text and the handoff marker that turn just
       * wrote. Only a regenerate means to truncate, and it says so.
       */
      const seedOver = (current: StoredMessage[] | undefined) => [
        ...(args.replacePrior || current === undefined ? prior : current),
        userMessage,
        assistantMessage,
      ]

      abortsRef.current.get(sessionId)?.abort()
      const controller = new AbortController()
      abortsRef.current.set(sessionId, controller)

      /**
       * Whether the turn's two rows have been handed to React yet. The opening
       * turn of a chat seeds them *inside* a view transition, which defers the
       * callback — and a backend that answers within that window would have
       * its first events applied to a thread that does not hold the assistant
       * row yet, and silently dropped. An ACP agent asking permission is
       * exactly that case: the request is often the first thing a turn emits,
       * and losing it leaves a turn blocked with no form to unblock it.
       */
      let seeded = false

      const paint = () => {
        seeded = true
        setThreads((prev) => ({
          ...prev,
          [sessionId]: seedOver(prev[sessionId]),
        }))
        setRuns((prev) => ({
          ...prev,
          [sessionId]: { startedAt, stage: "thinking" },
        }))
        setFailures((prev) => omit(prev, sessionId))
        // Last turn's marker belongs to last turn.
        setMemoryNotices((prev) =>
          sessionId in prev ? omit(prev, sessionId) : prev
        )
      }
      if (args.animate) runLayoutTransition(paint)
      else paint()

      if (args.titleFrom) {
        patchLocal(sessionId, { title: deriveSessionTitle(args.titleFrom) })
      }
      patchLocal(sessionId, {
        providerId: args.providerId,
        model: args.model,
        updatedAt: startedAt,
        messageCount: prior.length + 2,
      })

      const patchAssistant = (
        updater: (message: StoredMessage) => StoredMessage
      ) => {
        setThreads((prev) => {
          const current = prev[sessionId]
          if (!current) return prev
          const lastIndex = current.length - 1
          if (current[lastIndex]?.id === assistantId) {
            return {
              ...prev,
              [sessionId]: [
                ...current.slice(0, lastIndex),
                updater(current[lastIndex]),
              ],
            }
          }
          const index = current.findIndex(
            (message) => message.id === assistantId
          )
          if (index < 0) return prev
          const next = [...current]
          next[index] = updater(next[index])
          return {
            ...prev,
            [sessionId]: next,
          }
        })
      }

      const setStage = (stage: GenerationStage) => {
        setRuns((prev) => {
          const run = prev[sessionId]
          if (!run || run.startedAt !== startedAt) return prev
          // Real output supersedes whatever the backend last said it was up
          // to, so the stage change clears the status line with it.
          if (run.stage === stage && run.status === undefined) return prev
          return { ...prev, [sessionId]: { startedAt: run.startedAt, stage } }
        })
      }

      const setStatus = (status: string, stage: GenerationStage) => {
        setRuns((prev) => {
          const run = prev[sessionId]
          if (!run || run.startedAt !== startedAt) return prev
          if (run.stage === stage && run.status === status) return prev
          return { ...prev, [sessionId]: { ...run, stage, status } }
        })
      }

      let failed = false
      let needsAttention = false
      const markFailed = () => {
        failed = true
        setFailures((prev) => ({ ...prev, [sessionId]: true }))
      }

      /**
       * The OS notification for a turn that ended while the window was not
       * in front. `notifyAttention` itself stays quiet when it is; clicking
       * the notification (where the platform passes clicks on) opens the chat.
       */
      const notify = (
        kind: "completion" | "question" | "error",
        body?: string
      ) => {
        if (!(settingsRef.current?.chat.desktopNotifications ?? true)) return
        const title =
          sessionsRef.current.find((item) => item.id === sessionId)?.title ?? ""
        void notifyAttention({
          kind,
          chatId: sessionId,
          chatTitle: title,
          body,
          onClick: () => selectSessionRef.current(sessionId),
        })
      }

      const notifiedAskTools = new Set<string>()

      /**
       * Say why the turn stopped, in the turn itself. A message that already
       * has parts renders those and never its flat `content`, so a run that
       * died after some reasoning or a tool call used to leave a truncated
       * bubble and nothing but a toast that fades.
       */
      const failAssistant = (reason: string) => {
        failed = true
        drain()
        patchAssistant((message) =>
          message.content.trim()
            ? message
            : applyStreamEvent(message, {
                type: "text",
                text: `Agent error: ${reason}`,
              })
        )
        markFailed()
      }

      /**
       * Stream events land far faster than the browser can paint. Folding a
       * burst into one queued frame keeps the message list at one render per
       * frame instead of one per token, and the fold itself stays the shared
       * reducer so a reload of the thread still matches the live stream.
       */
      let queued: AgentStreamEvent[] = []
      let frame = 0
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined
      const cancelFlush = () => {
        if (frame && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(frame)
        }
        frame = 0
        if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
        fallbackTimer = undefined
      }
      const flush = () => {
        cancelFlush()
        /**
         * Aborting is not a reason to drop what already arrived: Stop leaves
         * the turn in place and the server persists every event it produced,
         * so swallowing the last frame would make a reload grow the answer.
         * A run that was superseded is safe on its own — `patchAssistant` is
         * keyed on `assistantId`, which the re-seeded thread no longer holds.
         */
        if (queued.length === 0) return
        // Nothing to apply to yet. Keep the batch and come back for it.
        if (!seeded) {
          schedule()
          return
        }
        const batch = queued
        queued = []
        patchAssistant((message) =>
          batch.reduce(
            (current, event) => applyStreamEvent(current, event),
            message
          )
        )
      }
      const schedule = () => {
        if (frame || fallbackTimer !== undefined) return
        frame =
          typeof requestAnimationFrame === "function"
            ? requestAnimationFrame(flush)
            : 0
        // Background WebViews can pause rAF indefinitely. The fallback keeps
        // queued stream events bounded even while the window is hidden.
        fallbackTimer = setTimeout(flush, document.hidden ? 50 : 100)
      }
      const enqueue = (event: AgentStreamEvent) => {
        const last = queued.at(-1)
        if (
          (event.type === "text" || event.type === "thinking") &&
          last?.type === event.type
        ) {
          queued[queued.length - 1] = { ...last, text: last.text + event.text }
        } else if (
          event.type === "tool" &&
          last?.type === "tool" &&
          last.id === event.id
        ) {
          queued[queued.length - 1] = event
        } else {
          queued.push(event)
        }
        schedule()
      }
      /** Run-level events must not overtake the text they follow. */
      const drain = () => {
        cancelFlush()
        flush()
      }

      const onEvent = (event: AgentStreamEvent) => {
        if (controller.signal.aborted) return
        if (event.type === "session") {
          patchLocal(sessionId, { providerSessionId: event.sessionId })
          return
        }
        if (event.type === "error") {
          toast.error(event.message)
          failAssistant(event.message)
          notify("error", event.message)
          return
        }
        if (event.type === "done") {
          drain()
          /**
           * Labels the turn's "Worked for 12s" row. The provider's own
           * `durationMs` wins over the wall clock for the same reason the
           * chat route prefers it when persisting: otherwise the number the
           * turn shows live would shift the moment the thread is reloaded.
           */
          const elapsed = (event.durationMs ?? nowMs() - startedAt) / 1000
          patchAssistant((message) => ({
            ...message,
            workedFor: elapsed,
            // Mirrors what the chat route persists, so the details popover
            // says the same thing before and after a reload.
            metadata: {
              model: args.model,
              providerId: args.providerId,
              responseTime: elapsed,
              finishedAt: nowMs(),
              ...folderMetadata(sessionsRef.current, sessionId),
              ...(event.usage?.input == null
                ? null
                : { inputTokens: event.usage.input }),
              ...(event.usage?.output == null
                ? null
                : { outputTokens: event.usage.output }),
              ...(event.usage?.tokensPerSecond == null
                ? null
                : { tokensPerSecond: event.usage.tokensPerSecond }),
              ...(event.usage?.input == null && event.usage?.output == null
                ? null
                : {
                    tokens:
                      (event.usage?.input ?? 0) + (event.usage?.output ?? 0),
                  }),
            },
          }))
          if (event.sessionId) {
            patchLocal(sessionId, { providerSessionId: event.sessionId })
          }
          if ((notificationSounds ?? true) && !failed && !needsAttention) {
            playAgentNotificationSound("completion")
          }
          if (!failed) {
            const answer = threadsRef.current[sessionId]
              ?.find((message) => message.id === assistantId)
              ?.content.trim()
            notify(needsAttention ? "question" : "completion", answer)
          }
          return
        }
        if (event.type === "status") {
          // Progress, not content: nothing to fold into the message.
          setStatus(event.text, statusStage(event.stage))
          return
        }
        if (event.type === "thinking") setStage("thinking")
        else if (event.type === "text") setStage("responding")
        else if (event.type === "tool") {
          setStage("searching")
          /*
           * A request is the one question that arrives *mid-turn*: the harness
           * is blocked on it and `done` will not come until it is answered, so
           * the notification cannot wait for the end of the run the way an ask
           * does. `notifyAttention` is still silent while the window is in
           * front, so this only ever reaches someone who has looked away.
           */
          const request = isOpenUserRequestTool(event)
            ? parseUserRequestInput(event.input)
            : null
          if (request || isOpenAskTool(event)) {
            needsAttention = true
            if ((notificationSounds ?? true) && !notifiedAskTools.has(event.id)) {
              notifiedAskTools.add(event.id)
              playAgentNotificationSound("question")
              if (request) notify("question", request.title)
            }
          }
        }
        enqueue(event)
      }

      /**
       * The app's own end-of-turn frame: which agents now hold a session in
       * this chat, and the handoff this turn was actually sent. Folding the
       * marker into the message here is what makes it survive a reload
       * unchanged — the chat route persisted the identical object.
       */
      const onTurnState = (state: TurnStateFrame) => {
        if (state.agentSessions) {
          patchLocal(sessionId, { agentSessions: state.agentSessions })
        }
        if (!state.handoff) return
        patchAssistant((message) =>
          message.id === state.messageId
            ? {
                ...message,
                metadata: { ...message.metadata, handoff: state.handoff },
              }
            : message
        )
      }

      /**
       * The chat's folder, for the two things that happen around a turn on
       * disk: the worktree checkpoint, and forgetting the cached file list.
       * A chat with no folder pays for neither.
       */
      const cwd = sessionsRef.current
        .find((item) => item.id === sessionId)
        ?.cwd?.trim()
      /**
       * Checkpoints are two `git` reads bracketing the turn, and a switch in
       * Settings → Chat. Read off the settings mirror rather than a prop, so
       * the runner is not rebuilt when the value lands or changes; a chat with
       * no folder has nothing to snapshot either way.
       */
      const checkpointCwd =
        cwd && settingsRef.current?.checkpoints.enabled !== false ? cwd : undefined
      /**
       * Which turn this is, and therefore which checkpoint refs bracket it:
       * the tree as it stood after turn N is the "before" of turn N+1, and the
       * baseline before the very first turn is turn 0.
       */
      const priorTurns = prior.reduce(
        (count, message) => (message.sender === "assistant" ? count + 1 : count),
        0
      )

      /**
       * The baseline, and it is awaited rather than fired off: a checkpoint
       * taken after the agent has already written a file does not describe the
       * state the user would want back. `ifMissing` is what keeps it cheap —
       * in a chat that has been running, the previous turn's own capture is
       * already that ref, and this costs one `rev-parse`.
       */
      if (checkpointCwd) {
        await postJson("/api/checkpoints/capture", {
          sessionId,
          turn: priorTurns,
          ifMissing: true,
        })
      }

      try {
        await api.streamChat(
          {
            prompt,
            providerId: args.providerId,
            model: args.model,
            sessionId,
            effort: args.effort,
            permissionMode: args.permissionMode,
            userMessageId: userMessage.id,
            assistantMessageId: assistantId,
            attachments: args.attachments,
            typedText: args.typedText,
          },
          { onEvent, onTurnState, signal: controller.signal }
        )
      } catch (err) {
        if (!controller.signal.aborted) {
          const message = errorMessage(err, "The agent run failed")
          toast.error(message)
          // An `error` event already said so, notification included.
          if (!failed) notify("error", message)
          failAssistant(message)
        }
      } finally {
        drain()
        if (abortsRef.current.get(sessionId) === controller) {
          abortsRef.current.delete(sessionId)
        }
        setRuns((prev) =>
          prev[sessionId]?.startedAt === startedAt ? omit(prev, sessionId) : prev
        )
        patchLocal(sessionId, { updatedAt: nowMs() })
        /**
         * What the turn actually did to the disk — a stopped one included,
         * since Stop does not un-write the files the agent had already
         * written. The route takes the checkpoint, diffs it against the
         * baseline and stores the rows on the assistant message; the copy
         * that comes back is folded in here so the file card is right without
         * waiting for a reload.
         *
         * Awaited before the queue drains: the next turn's baseline is this
         * turn's checkpoint, and two captures racing for the same ref would
         * make the chain describe a tree neither of them saw.
         */
        if (checkpointCwd) {
          const captured = await postJson<{ checkpoint?: TurnCheckpoint }>(
            "/api/checkpoints/capture",
            {
              sessionId,
              turn: priorTurns + 1,
              baseTurn: priorTurns,
              messageId: assistantId,
            }
          )
          const checkpoint = captured?.checkpoint
          if (checkpoint) {
            patchAssistant((message) => ({
              ...message,
              metadata: { ...message.metadata, checkpoint },
            }))
          }
        }
        /* The `@` menu caches the folder's file list for half a minute, which
           is exactly wrong the moment a turn creates the file the user is
           about to go looking for. */
        if (cwd) void postJson("/api/fs/invalidate", { sessionId })
        /* Only a turn that actually landed is worth learning from. A stopped
           one is usually about to be re-sent, and a failed one would spend a
           model call to stack a second toast under the failure's own. */
        if (!controller.signal.aborted && !failed) {
          void runMemoryUpdate(sessionId)
        }
        /* A message queued during the turn goes next — a stopped turn keeps
           its queue, since Stop usually means "let me rephrase". */
        if (!controller.signal.aborted) drainQueueRef.current(sessionId)
      }
    },
    [
      abortsRef,
      drainQueueRef,
      notificationSounds,
      patchLocal,
      runMemoryUpdate,
      selectSessionRef,
      sessionsRef,
      setFailures,
      setMemoryNotices,
      setRuns,
      setThreads,
      settingsRef,
      threadsRef,
    ]
  )
}
