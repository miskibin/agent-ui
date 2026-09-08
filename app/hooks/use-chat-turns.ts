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
import { dispatchSkillMentions, skillMentions } from "@/lib/skills"
import { parseSlashCommand } from "@/lib/slash-commands"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"
import type { UserRequestAnswer } from "@/lib/turn-requests"

import { EMPTY_MESSAGES, type QueuedMessage, type SessionRun } from "./chat-types"
import type { ChatRefs } from "./use-chat-refs"
import type { LoadThread } from "./use-threads"
import type { RunPrompt } from "./use-turn-runner"

/** What the Build button under a plan card says, in the user's own voice. */
/**
 * How long an answered question waits for the stopped turn to let go before
 * rewriting the transcript anyway. Long enough for a fetch to unwind, short
 * enough that a wedged runner cannot hold the answer hostage.
 */
const SETTLE_TIMEOUT_MS = 1_500

const BUILD_PROMPT = "Go ahead and implement the plan above."

/** The harness's own command for shortening a conversation it is holding. */
const COMPACT_PROMPT = "/compact"

/**
 * `lib/skills` names harnesses the way the CLIs and their transcripts do; this
 * app keys providers by the settings key they are configured under. One map,
 * in one place, so a dispatch can never be silently a no-op — the same
 * translation `components/provider-picker` does for the brand marks.
 */
const SKILL_HARNESS: Record<string, string> = {
  claudeCode: "claude-code",
  cursorAgent: "cursor",
}

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
  effectivePermission,
  permissionModes,
  choosePermission,
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
  knownSkillNamesRef,
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
  /** What the composer shows — the pick, else the harness's own default. */
  effectivePermission: PermissionMode | ""
  permissionModes: readonly PermissionMode[]
  choosePermission: (mode: PermissionMode) => void
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
  /** The skills this machine offers, as `app/hooks/use-skills` last read them. */
  knownSkillNamesRef: React.RefObject<ReadonlySet<string>>
}) {
  const { abortsRef, activeIdRef, drainQueueRef, sessionsRef, threadsRef } = refs

  const send = React.useCallback(
    async (
      text: string,
      files: File[],
      skills: string[],
      targetId?: string,
      /**
       * This one turn's mode, overriding the composer's. The Build button
       * leaves plan mode and sends in the same click, and a state update is
       * not visible to the closure that would read it.
       */
      permissionOverride?: PermissionMode
    ) => {
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
        : permissionOverride || chosenPermission || undefined
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

      /**
       * `$review` is this app's spelling of a skill; the harness has its own,
       * or none at all. Only the *prompt* is rewritten — `typedText` below
       * stays exactly what the user typed, which is what the memory extractor
       * is held to and what ArrowUp brings back.
       */
      const known = knownSkillNamesRef.current
      const promptText = dispatchSkillMentions(
        text,
        SKILL_HARNESS[runProvider] ?? runProvider,
        known
      )
      /**
       * A skill that reached the harness as a real invocation is not named
       * again in the prefix: that prefix exists for a backend with no
       * invocation form of its own, where saying so in prose is all there is.
       */
      const invoked =
        promptText === text
          ? new Set<string>()
          : new Set(skillMentions(text, known).map((mention) => mention.name))
      const namedSkills = skills.filter((name) => !invoked.has(name))
      const skillPrefix =
        namedSkills.length > 0 ? `[skills: ${namedSkills.join(", ")}] ` : ""

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
      const content = `${skillPrefix}${promptText}${fenced}${fileNote}`
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
        // What the memory extractor is shown: the prompt carries the skill
        // invocations, the prefix, the fenced attachments and the file note
        // as well.
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
      knownSkillNamesRef,
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

  /**
   * Stops a chat's turn and resolves once the runner has actually let go of
   * it, rather than the instant `abort()` returns.
   *
   * The difference matters to exactly one caller. `use-turn-runner` folds a
   * burst of stream events into one queued frame and flushes whatever is left
   * from its `finally` — deliberately, because Stop leaves the turn in place
   * and the server has already persisted every event it produced. So a
   * transcript rewritten between the abort and that last flush is a transcript
   * the dying turn writes over. The runner drops its controller immediately
   * after that flush, which makes the controller's absence the signal that the
   * coast is clear.
   *
   * Capped, because a runner that never reaches its `finally` must not be able
   * to swallow the user's answer: after that the rewrite goes ahead anyway.
   */
  const stopAndSettle = React.useCallback(
    async (sessionId: string) => {
      const controller = abortsRef.current.get(sessionId)
      if (!controller) return
      controller.abort()
      setRuns((prev) => omit(prev, sessionId))
      const deadline = Date.now() + SETTLE_TIMEOUT_MS
      while (
        abortsRef.current.get(sessionId) === controller &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 16))
      }
      abortsRef.current.delete(sessionId)
    },
    [abortsRef, setRuns]
  )

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

  /**
   * The user answers the question the agent asked.
   *
   * A question is a stop sign, and it is answerable the moment it appears —
   * including while the turn that asked it is still generating. That case is
   * the whole point: a harness that cannot block on its own ask tool carries
   * on regardless, and by the time the turn ended it had already chosen for
   * itself and written a plan around the guess. So answering *stops* the turn
   * first, which is what "asking" was supposed to mean.
   *
   * Stopping is awaited rather than fired off, because the transcript is
   * rewritten next and a turn still holding a queued frame would write over
   * the answer — see `stopAndSettle`.
   */
  const handleAskAnswer = React.useCallback(
    (messageId: string, toolId: string, result: AskQuestionResult) => {
      const sessionId = activeId
      void (async () => {
        await stopAndSettle(sessionId)
        // Read *after* the stop: the last flush belongs in the transcript this
        // answer is recorded on.
        const next = completeAsk(
          threadsRef.current[sessionId] ?? EMPTY_MESSAGES,
          messageId,
          toolId,
          result
        )
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
      stopAndSettle,
      threadsRef,
    ]
  )

  /**
   * The other half of `PendingUserRequest`: a turn that is *still running* and
   * blocked on the user. Nothing is rewritten here — the answer goes to the
   * server, the provider unblocks, and the outcome arrives on the SSE stream
   * this chat is already reading, which is what closes the form.
   */
  const handleRequestAnswer = React.useCallback(
    async (requestId: string, answer: UserRequestAnswer) => {
      const sessionId = activeId
      try {
        await api.respondToRequest(sessionId, requestId, answer)
      } catch (err) {
        toast.error(errorMessage(err, "Could not send your answer"))
        throw err
      }
    },
    [activeId]
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

  /**
   * The Build button under a plan card.
   *
   * A plan is a proposal, so building it is two things at once: leaving the
   * mode that could only write it down — where the harness has one — and
   * asking, in the chat's own transcript, for the work. The mode rides along
   * as this turn's override because the state it also sets lands a render too
   * late for the send that follows it.
   */
  const handlePlanBuild = React.useCallback(() => {
    const leaving =
      effectivePermission === "plan"
        ? (["edits", "full"] as const).find((mode) =>
            permissionModes.includes(mode)
          )
        : undefined
    if (leaving) choosePermission(leaving)
    void send(BUILD_PROMPT, [], [], undefined, leaving)
  }, [choosePermission, effectivePermission, permissionModes, send])

  /**
   * "Compact context" — the composer's meter offering the harness's own
   * `/compact`.
   *
   * Nothing special happens here on purpose: an unknown `/x` already reaches
   * the backend exactly as typed, so this is one ordinary turn, visible in
   * the transcript like any other. The toast is there because the turn that
   * answers it says very little.
   */
  const handleCompact = React.useCallback(() => {
    if (!activeIdRef.current) return
    toast.message("Compacting the conversation…")
    void send(COMPACT_PROMPT, [], [])
  }, [activeIdRef, send])

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
    handleRequestAnswer,
    handlePlanBuild,
    handleCompact,
    handleEditMessage,
    handleRegenerate,
    handleDeleteMessage,
  }
}
