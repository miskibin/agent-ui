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
import type { MemoryChange } from "@/lib/memory/types"
import type { PermissionMode } from "@/lib/providers/types"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"

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
  /** The app wrote this prompt, not the user — keep it out of the list. */
  internal?: boolean
}

export type RunPrompt = (args: RunPromptArgs) => Promise<void>

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
      const seeded = [...prior, userMessage, seedAssistantMessage(assistantId)]

      abortsRef.current.get(sessionId)?.abort()
      const controller = new AbortController()
      abortsRef.current.set(sessionId, controller)

      const paint = () => {
        setThreads((prev) => ({ ...prev, [sessionId]: seeded }))
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
        messageCount: seeded.length,
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
        const batch = queued
        queued = []
        /**
         * Aborting is not a reason to drop what already arrived: Stop leaves
         * the turn in place and the server persists every event it produced,
         * so swallowing the last frame would make a reload grow the answer.
         * A run that was superseded is safe on its own — `patchAssistant` is
         * keyed on `assistantId`, which the re-seeded thread no longer holds.
         */
        if (batch.length === 0) return
        patchAssistant((message) =>
          batch.reduce(
            (current, event) => applyStreamEvent(current, event),
            message
          )
        )
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
        if (frame || fallbackTimer !== undefined) return
        frame =
          typeof requestAnimationFrame === "function"
            ? requestAnimationFrame(flush)
            : 0
        // Background WebViews can pause rAF indefinitely. The fallback keeps
        // queued stream events bounded even while the window is hidden.
        fallbackTimer = setTimeout(flush, document.hidden ? 50 : 100)
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
          if (isOpenAskTool(event)) {
            needsAttention = true
            if ((notificationSounds ?? true) && !notifiedAskTools.has(event.id)) {
              notifiedAskTools.add(event.id)
              playAgentNotificationSound("question")
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
