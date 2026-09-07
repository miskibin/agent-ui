"use client"

import * as React from "react"

import { collectChatChanges } from "@/components/chat-changes"
import { contextTurnUsage } from "@/components/context-usage"
import { parseAskQuestionInput } from "@/components/ui/ask-question"
import type { ModelOption } from "@/components/ui/model-picker"
import { findPendingAsk, isInternalMessage } from "@/lib/ask-tools"
import type { StoredMessage } from "@/lib/store/types"
import { latestTodos } from "@/lib/todo-plan"
import { chatUsage } from "@/lib/usage"
import { turnFiles } from "@/lib/turn-files"

import type { SessionRun } from "./chat-types"

/**
 * A turn's file card, cached against the stored message so it is built once
 * per turn rather than once per render. `turnFiles` answers undefined when it
 * has nothing to add, and the message object is then handed on untouched —
 * which is what keeps the memoized row from re-rendering.
 */
const turnFilesCache = new WeakMap<StoredMessage, StoredMessage>()

/** What the composer's ArrowUp recall walks, oldest first. */
export type PromptHistoryItem = { id: string; text: string }

const EMPTY_HISTORY: PromptHistoryItem[] = []

/**
 * The last list built, and the list it was built from. One entry is enough —
 * one chat is open at a time — and it exists for identity, not for speed: the
 * composer is memoized, so a fresh array every frame of a streaming turn would
 * rebuild it (and the pickers inside it) on every token. The entries only
 * change when a prompt is sent, edited or deleted, so the previous array is
 * returned whenever the ids and the texts still match.
 */
let lastPrompts: PromptHistoryItem[] = EMPTY_HISTORY

/**
 * What the user actually typed, in order — `metadata.typedText` where the
 * composer folded an attachment or a skill into the prompt, the stored content
 * otherwise. The app's own turns (an Ask Question answer) are not prompts and
 * never come back on ArrowUp.
 */
function promptHistory(messages: StoredMessage[]): PromptHistoryItem[] {
  const next: PromptHistoryItem[] = []
  for (const message of messages) {
    if (message.sender !== "user" || isInternalMessage(message)) continue
    const text = message.metadata?.typedText ?? message.content
    if (text.trim()) next.push({ id: message.id, text })
  }
  if (next.length === 0) return EMPTY_HISTORY
  const previous = lastPrompts
  const same =
    previous.length === next.length &&
    next.every(
      (entry, index) =>
        entry.id === previous[index].id && entry.text === previous[index].text
    )
  if (same) return previous
  lastPrompts = next
  return next
}

/**
 * The context window the backend itself reported for the newest turn that
 * reported one. It outranks the model catalog: a CLI harness answers under an
 * id the catalog has never heard of (`claude-code`'s bare `sonnet`), so
 * without this the composer's meter has no total and does not show at all.
 */
function reportedContextWindow(messages: StoredMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.sender !== "assistant") continue
    const window = message.metadata?.contextWindow
    if (window) return window
  }
  return undefined
}

/**
 * When the newest answer settled. The offer to compact before resuming reads
 * it, and it is the turn's own clock rather than the chat's `updatedAt` —
 * which a rename, a pin or a folder change also moves.
 */
function lastTurnAt(messages: StoredMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.sender !== "assistant") continue
    const finished = message.metadata?.finishedAt
    if (finished) return finished
  }
  return undefined
}

export function withTurnFiles(message: StoredMessage): StoredMessage {
  const cached = turnFilesCache.get(message)
  if (cached) return cached
  const changes = message.changes ?? turnFiles(message)
  const next = changes === message.changes ? message : { ...message, changes }
  turnFilesCache.set(message, next)
  return next
}

/**
 * Everything the conversation column derives from the open thread.
 *
 * The expensive scans run against a *deferred* copy of the transcript: a
 * streaming turn rewrites it every frame while a plan, a cost or a change card
 * moves a handful of times per run, so React is left to drop the intermediate
 * passes rather than the page paying for them.
 */
export function useThreadView({
  messages,
  threads,
  activeId,
  runs,
  models,
  model,
  isGenerating,
}: {
  /** The open chat's transcript — `threads[activeId]`, or the frozen empty. */
  messages: StoredMessage[]
  threads: Record<string, StoredMessage[]>
  activeId: string
  runs: Record<string, SessionRun>
  models: ModelOption[]
  model: string
  isGenerating: boolean
}) {
  /**
   * Ask Question answers are replayed to the model as a user turn, but the
   * tool row above already shows them — rendering the raw prompt as well is
   * duplicate noise. Keeps the same array when there is nothing to drop, so
   * the memoized rows never re-render for this.
   */
  const visibleMessages = React.useMemo(
    () =>
      messages.some(isInternalMessage)
        ? messages.filter((message) => !isInternalMessage(message))
        : messages,
    [messages]
  )

  /**
   * The plan bar above the composer. A streaming turn rewrites `messages` every
   * frame while the plan itself changes a handful of times per run, so the scan
   * runs against a deferred copy — React drops the intermediate ones.
   */
  const deferredMessages = React.useDeferredValue(messages)
  const todos = React.useMemo(
    () => latestTodos(deferredMessages),
    [deferredMessages]
  )

  /**
   * The composer's context ring. `base` is recomputed every render but only
   * *changes* when a turn reports its usage, so the memoized composer is not
   * rebuilt while one is streaming.
   */
  const contextTurn = contextTurnUsage(messages)
  const contextTotal = React.useMemo(
    () =>
      reportedContextWindow(deferredMessages) ??
      models.find((option) => option.id === model)?.contextLength,
    [deferredMessages, model, models]
  )
  /**
   * What the chat has spent so far: the composer's context ring takes the
   * total, the header's control takes the whole breakdown. One pass over the
   * deferred transcript feeds both, so a streaming turn pays for neither.
   */
  const usage = React.useMemo(
    () => chatUsage(deferredMessages),
    [deferredMessages]
  )
  const activeCost = usage?.cost ?? null
  /** For the meter's "compact before resuming?" offer — see `context-usage`. */
  const lastTurnFinishedAt = React.useMemo(
    () => lastTurnAt(deferredMessages),
    [deferredMessages]
  )

  /**
   * The transcript as the list sees it: same objects, except where a turn's
   * file card needs the media it produced folded in (`lib/turn-files`). The
   * live turn is left alone — its card is only rendered once it settles, so
   * rebuilding it per token would be pure waste.
   */
  const pendingAsk = React.useMemo(
    () => {
      const ask = findPendingAsk(messages)
      return ask && parseAskQuestionInput(ask.input) ? ask : null
    },
    [messages]
  )

  const listMessages = React.useMemo(() => {
    const live = isGenerating ? visibleMessages.length - 1 : -1
    let patched = false
    const next = visibleMessages.map((message, index) => {
      let withFiles = index === live ? message : withTurnFiles(message)
      // The active form lives above the composer. Keep its stored tool intact
      // so answering it restores the summary in the original turn.
      if (pendingAsk && message.id === pendingAsk.messageId) {
        withFiles = {
          ...withFiles,
          tools: withFiles.tools?.filter((tool) => tool.id !== pendingAsk.toolId),
          parts: withFiles.parts?.filter(
            (part) => part.type !== "tool" || part.tool.id !== pendingAsk.toolId
          ),
        }
      }
      if (withFiles !== message) patched = true
      return withFiles
    })
    return patched ? next : visibleMessages
  }, [isGenerating, pendingAsk, visibleMessages])

  /**
   * Chats waiting on an answer, across every loaded thread — what the dock
   * badge counts. Only loaded threads can be checked; a chat that has never
   * been opened this session cannot be waiting on anything.
   */
  const waitingCount = React.useMemo(
    () =>
      Object.entries(threads).filter(
        ([id, thread]) =>
          id !== activeId && !runs[id] && findPendingAsk(thread) !== null
      ).length,
    [activeId, runs, threads]
  )

  /**
   * The prompts the composer's ArrowUp walks. Derived from the deferred
   * transcript and identity-stable, so a streaming turn never rebuilds the
   * memoized composer for it.
   */
  const history = React.useMemo(
    () => promptHistory(deferredMessages),
    [deferredMessages]
  )

  /** Every file the chat changed, across its turns — the header's count. */
  const chatChanges = React.useMemo(
    () =>
      collectChatChanges(
        isGenerating ? deferredMessages.slice(0, -1) : deferredMessages
      ),
    [deferredMessages, isGenerating]
  )

  return {
    visibleMessages,
    listMessages,
    todos,
    contextTurn,
    contextTotal,
    activeCost,
    lastTurnFinishedAt,
    usage,
    pendingAsk,
    waitingCount,
    chatChanges,
    history,
  }
}
