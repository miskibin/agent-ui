"use client"

import * as React from "react"
import { toast } from "sonner"

import type { AskQuestionResult } from "@/components/ui/ask-question"
import type { ChatInputPayload } from "@/components/ui/chat-input"
import type { MessageAttachmentData } from "@/components/ui/message"
import * as api from "@/lib/api-client"
import {
  MAX_IMAGE_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  fenceTextAttachment,
  isImageFile,
  isTextFile,
  readFileAsDataUrl,
  readFileAsText,
} from "@/lib/attachments"
import {
  ASK_ANSWER_PREFIX,
  ASK_ANSWER_SKIPPED,
  completeAsk,
  findPendingAsk,
} from "@/lib/ask-tools"
import { errorMessage, nowMs, omit } from "@/lib/chat-helpers"
import { runLayoutTransition } from "@/lib/layout-transition"
import { newId } from "@/lib/message-stream"
import type {
  PermissionMode,
  ProviderCapabilities,
  ProviderInfo,
} from "@/lib/providers/types"
import { parseSlashCommand } from "@/lib/slash-commands"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"

import { EMPTY_MESSAGES, type QueuedMessage, type SessionRun } from "./chat-types"
import type { ChatRefs } from "./use-chat-refs"
import type { LoadThread } from "./use-threads"
import type { RunPrompt } from "./use-turn-runner"

/**
 * Everything that starts, stops or rewrites a turn.
 *
 * `send` is the whole composer path: the app's own `/` commands, attachments
 * (images to a harness that can see them, text files fenced inline, everything
 * else named), creating the chat when there is not one yet, and the detached
 * case — a queued message that lands after the user has moved on runs with the
 * agent *its own* chat remembers, never the one now on screen.
 */
export function useChatTurns({
  refs,
  runPrompt,
  loadThread,
  activeId,
  sessions,
  providers,
  providerId,
  model,
  effort,
  capabilities,
  visionModels,
  chosenPermission,
  autoTitle,
  patchLocal,
  setSessions,
  setActiveId,
  setThreads,
  setRuns,
  setFailures,
  takeQueued,
  handleNewChat,
  renameSession,
  regenerateTitle,
  startRename,
  openFolder,
  pushSettings,
}: {
  refs: ChatRefs
  runPrompt: RunPrompt
  loadThread: LoadThread
  activeId: string
  sessions: SessionMeta[]
  providers: ProviderInfo[]
  providerId: string
  model: string
  effort: string
  capabilities: ProviderCapabilities | null
  visionModels: string[]
  chosenPermission: PermissionMode | ""
  autoTitle: boolean | undefined
  patchLocal: (id: string, patch: Partial<SessionMeta>) => void
  setSessions: React.Dispatch<React.SetStateAction<SessionMeta[]>>
  setActiveId: React.Dispatch<React.SetStateAction<string>>
  setThreads: React.Dispatch<
    React.SetStateAction<Record<string, StoredMessage[]>>
  >
  setRuns: React.Dispatch<React.SetStateAction<Record<string, SessionRun>>>
  setFailures: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  takeQueued: (sessionId: string, id: string) => QueuedMessage | null
  handleNewChat: () => Promise<void>
  renameSession: (id: string, title: string) => void
  regenerateTitle: (id: string) => void
  startRename: (id: string) => void
  openFolder: (action: "editor" | "reveal" | "terminal") => void
  /** `/settings` — opens the settings panel, kept out of this hook. */
  pushSettings: () => void
}) {
  const { abortsRef, activeIdRef, drainQueueRef, sessionsRef, threadsRef } = refs

  const send = React.useCallback(
    async (text: string, files: File[], skills: string[], targetId?: string) => {
      const trimmed = text.trim()
      if (!trimmed && files.length === 0) return

      let sessionId = targetId ?? activeId
      let prior = threadsRef.current[sessionId] ?? EMPTY_MESSAGES

      // A queued message may land after the user has moved to another chat;
      // it runs with the agent its own chat remembers, not the one on screen.
      const target = sessionsRef.current.find((item) => item.id === sessionId)
      const detached = !!targetId && targetId !== activeIdRef.current && !!target
      const runProvider = detached ? target.providerId : providerId
      const runModel = detached ? target.model : model
      /**
       * Everything else about the run is the *open* chat's — its harness's
       * capabilities, the effort picked, the permission mode shown — none of
       * which may leak into another chat's turn: a read-only chat's queued
       * message must not run under the `full` of the chat now on screen. A
       * detached run takes the target's own stored mode (the chat route
       * validates it against that harness), no effort, and no images.
       */
      const runPermission: PermissionMode | undefined = detached
        ? ((target.permissionMode as PermissionMode | undefined) || undefined)
        : chosenPermission || undefined
      const runEffort = detached
        ? undefined
        : capabilities?.effort
          ? effort
          : undefined

      const command = parseSlashCommand(trimmed)
      if (command && !detached) {
        switch (command.name) {
          case "clear": {
            if (!sessionId) return
            abortsRef.current.get(sessionId)?.abort()
            setRuns((prev) => omit(prev, sessionId))
            setFailures((prev) => omit(prev, sessionId))
            runLayoutTransition(() =>
              setThreads((prev) => ({ ...prev, [sessionId]: [] }))
            )
            patchLocal(sessionId, { messageCount: 0, providerSessionId: "" })
            void api
              .putMessages(sessionId, [])
              .then(() =>
                api.patchSession(sessionId, { providerSessionId: "" })
              )
              .catch((err: unknown) =>
                toast.error(errorMessage(err, "Could not clear the chat"))
              )
            return
          }
          case "new":
            void handleNewChat()
            return
          case "rename":
            if (!sessionId) return
            if (command.arg) renameSession(sessionId, command.arg)
            else startRename(sessionId)
            return
          case "title":
            if (sessionId) regenerateTitle(sessionId)
            return
          case "open":
            openFolder("editor")
            return
          case "reveal":
            openFolder("reveal")
            return
          case "terminal":
            openFolder("terminal")
            return
          case "settings":
            pushSettings()
            return
        }
      }

      const skillPrefix =
        skills.length > 0 ? `[skills: ${skills.join(", ")}] ` : ""

      // Only images can travel as real attachments, and only to a provider
      // and model that can actually look at them — everything else falls
      // back to the original behavior: a plain name mentioned in the text.
      const visionEligible =
        !detached && !!capabilities?.vision && visionModels.includes(model)
      const imageFiles = files.filter(isImageFile)
      const otherFiles = files.filter((file) => !isImageFile(file))
      const oversizedImages = imageFiles.filter(
        (file) => file.size > MAX_IMAGE_BYTES
      )
      const sizedImages = imageFiles.filter(
        (file) => file.size <= MAX_IMAGE_BYTES
      )

      if (oversizedImages.length > 0) {
        const limitMb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024))
        toast.error(
          oversizedImages.length === 1
            ? `"${oversizedImages[0].name}" is over ${limitMb}MB — attaching the name only`
            : `${oversizedImages.length} images are over ${limitMb}MB — attaching the names only`
        )
      }

      let attachments: MessageAttachmentData[] = []
      let namedOnly = [...oversizedImages]

      // A text file rides along in full, fenced and named, so the model reads
      // it the way it would a pasted snippet. Anything else is mentioned by
      // name — a PDF has no text to lift without a parser.
      let fenced = ""
      for (const file of otherFiles) {
        if (!isTextFile(file) || file.size > MAX_TEXT_ATTACHMENT_BYTES) {
          namedOnly.push(file)
          continue
        }
        try {
          fenced += fenceTextAttachment(file.name, await readFileAsText(file))
        } catch {
          toast.error(`Could not read ${file.name} — attaching the name only`)
          namedOnly.push(file)
        }
      }

      if (sizedImages.length > 0) {
        if (visionEligible) {
          try {
            attachments = await Promise.all(
              sizedImages.map(async (file) => ({
                id: newId(),
                name: file.name,
                mimeType: file.type || "image/*",
                url: await readFileAsDataUrl(file),
              }))
            )
          } catch (err) {
            toast.error(errorMessage(err, "Could not read an attached image"))
            namedOnly = [...namedOnly, ...sizedImages]
          }
        } else {
          const activeName =
            providers.find((item) => item.id === runProvider)?.name ??
            runProvider
          toast.message(
            `${activeName || "This provider"} can't see images — attaching the name only`
          )
          namedOnly = [...namedOnly, ...sizedImages]
        }
      }

      const fileNote =
        namedOnly.length > 0
          ? `\n\nAttached: ${namedOnly.map((file) => file.name).join(", ")}`
          : ""
      const content = `${skillPrefix}${text}${fenced}${fileNote}`
      // A screenshot on its own is a message; only nothing at all is nothing.
      if (!content.trim() && attachments.length === 0) return

      if (!sessionId) {
        try {
          const created = await api.createSession({
            providerId,
            model,
            permissionMode: chosenPermission || undefined,
          })
          sessionId = created.id
          prior = EMPTY_MESSAGES
          setSessions((prev) => [created, ...prev])
          setThreads((prev) => ({ ...prev, [created.id]: [] }))
          setActiveId(created.id)
        } catch (err) {
          toast.error(errorMessage(err, "Could not start a new chat"))
          return
        }
      } else if (threadsRef.current[sessionId] === undefined) {
        /**
         * The composer stays live while a transcript is still loading, and a
         * queued message can land on a chat the LRU has since dropped. Seeding
         * the turn from a thread that has not arrived would leave the chat as
         * this one exchange — which the next inline edit then persists over
         * the real history — so wait for the body and take its own prior.
         */
        prior = (await loadThread(sessionId)) ?? EMPTY_MESSAGES
      }

      // An unanswered ask block is treated as skipped once the user types on.
      const pending = findPendingAsk(prior)
      if (pending) {
        prior = completeAsk(prior, pending.messageId, pending.toolId, {
          skipped: true,
          answers: {},
        })
        setThreads((prev) => ({ ...prev, [sessionId]: prior }))
        await api.putMessages(sessionId, prior).catch(() => {
          /* the run below rewrites the thread anyway */
        })
      }

      const session = sessions.find((item) => item.id === sessionId)
      void runPrompt({
        sessionId,
        prompt: content,
        // What the memory extractor is shown: the prompt carries the skills
        // prefix, the fenced attachments and the file note as well.
        typedText: text,
        prior,
        providerId: runProvider,
        model: runModel,
        effort: runEffort,
        permissionMode: runPermission,
        attachments,
        animate: prior.length === 0,
        titleFrom:
          prior.length === 0 &&
          (autoTitle ?? true) &&
          (!session?.title || session.title === "New chat")
            ? content
            : undefined,
      })
    },
    [
      abortsRef,
      activeId,
      activeIdRef,
      autoTitle,
      capabilities?.effort,
      capabilities?.vision,
      chosenPermission,
      effort,
      handleNewChat,
      loadThread,
      model,
      openFolder,
      patchLocal,
      providerId,
      providers,
      pushSettings,
      regenerateTitle,
      renameSession,
      runPrompt,
      sessions,
      sessionsRef,
      setActiveId,
      setFailures,
      setRuns,
      setSessions,
      setThreads,
      startRename,
      threadsRef,
      visionModels,
    ]
  )

  const handleSend = React.useCallback(
    (payload: ChatInputPayload) => {
      void send(payload.text, payload.files, payload.skills)
    },
    [send]
  )

  /** Sends the next queued message of a chat, if any. Called as a turn ends. */
  const drainQueue = React.useCallback(
    (sessionId: string) => {
      const next = refs.queuesRef.current[sessionId]?.[0]
      if (!next) return
      takeQueued(sessionId, next.id)
      void send(next.text, next.files, next.skills, sessionId)
    },
    [refs.queuesRef, send, takeQueued]
  )
  React.useEffect(() => {
    drainQueueRef.current = drainQueue
  }, [drainQueue, drainQueueRef])

  const handleStop = React.useCallback(() => {
    abortsRef.current.get(activeId)?.abort()
    abortsRef.current.delete(activeId)
    setRuns((prev) => omit(prev, activeId))
  }, [abortsRef, activeId, setRuns])

  /** Rewrites the stored thread after an in-place edit / delete / ask answer. */
  const commitThread = React.useCallback(
    async (sessionId: string, next: StoredMessage[]) => {
      setThreads((prev) => ({ ...prev, [sessionId]: next }))
      patchLocal(sessionId, { messageCount: next.length, updatedAt: nowMs() })
      try {
        await api.putMessages(sessionId, next)
      } catch (err) {
        toast.error(errorMessage(err, "Could not save the chat"))
      }
    },
    [patchLocal, setThreads]
  )

  const handleAskAnswer = React.useCallback(
    (messageId: string, toolId: string, result: AskQuestionResult) => {
      const sessionId = activeId
      const next = completeAsk(
        threadsRef.current[sessionId] ?? EMPTY_MESSAGES,
        messageId,
        toolId,
        result
      )
      void (async () => {
        await commitThread(sessionId, next)
        await runPrompt({
          sessionId,
          prompt: result.skipped
            ? ASK_ANSWER_SKIPPED
            : `${ASK_ANSWER_PREFIX}${JSON.stringify(result.answers)}`,
          prior: next,
          providerId,
          model,
          effort: capabilities?.effort ? effort : undefined,
          permissionMode: chosenPermission || undefined,
          internal: true,
        })
      })()
    },
    [
      activeId,
      capabilities?.effort,
      chosenPermission,
      commitThread,
      effort,
      model,
      providerId,
      runPrompt,
      threadsRef,
    ]
  )

  const handleEditMessage = React.useCallback(
    (id: string, content: string) => {
      const sessionId = activeId
      const next = (threadsRef.current[sessionId] ?? EMPTY_MESSAGES).map(
        (message) => (message.id === id ? { ...message, content } : message)
      )
      void commitThread(sessionId, next)
    },
    [activeId, commitThread, threadsRef]
  )

  /** Drops the assistant turn and re-runs the user prompt above it. */
  const handleRegenerate = React.useCallback(
    (messageId: string) => {
      const sessionId = activeId
      const current = threadsRef.current[sessionId] ?? EMPTY_MESSAGES
      const index = current.findIndex((message) => message.id === messageId)
      let userIndex = index - 1
      while (userIndex >= 0 && current[userIndex].sender !== "user") userIndex--
      if (userIndex < 0) return
      const prompt = current[userIndex].content
      /**
       * Everything from the user turn down goes, question included: the run
       * below re-appends it — once in the optimistic thread, once server-side
       * — so keeping it here would leave the prompt duplicated in the UI and
       * on disk.
       */
      const next = current.slice(0, userIndex)
      void (async () => {
        await commitThread(sessionId, next)
        await runPrompt({
          sessionId,
          prompt,
          prior: next,
          // The turn below the one being re-run is gone: seed over `prior`
          // rather than onto the thread. `typedText` is not knowable here —
          // the stored message is all that is left of what was typed.
          replacePrior: true,
          providerId,
          model,
          effort: capabilities?.effort ? effort : undefined,
          permissionMode: chosenPermission || undefined,
        })
      })()
    },
    [
      activeId,
      capabilities?.effort,
      chosenPermission,
      commitThread,
      effort,
      model,
      providerId,
      runPrompt,
      threadsRef,
    ]
  )

  const handleDeleteMessage = React.useCallback(
    (messageId: string) => {
      const sessionId = activeId
      const next = (threadsRef.current[sessionId] ?? EMPTY_MESSAGES).filter(
        (message) => message.id !== messageId
      )
      void commitThread(sessionId, next)
    },
    [activeId, commitThread, threadsRef]
  )

  return {
    send,
    handleSend,
    handleStop,
    handleAskAnswer,
    handleEditMessage,
    handleRegenerate,
    handleDeleteMessage,
  }
}
