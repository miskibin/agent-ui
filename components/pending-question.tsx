"use client"

import * as React from "react"

import {
  AskQuestion,
  parseAskQuestionInput,
  type AskQuestionItem,
  type AskQuestionResult,
} from "@/components/ui/ask-question"
import type { UserRequest, UserRequestAnswer } from "@/lib/turn-requests"
import { cn } from "@/lib/utils"

/**
 * The one answerable form, outside the transcript's scrolling surface.
 *
 * Two things land here and they are answered very differently. An AskQuestion
 * tool belongs to a turn that has *ended*: answering rewrites the transcript
 * and starts a new turn, so the form is disabled while one is generating.
 * A `UserRequest` belongs to a turn that is still running and blocked on the
 * answer (`lib/turn-requests`) — generating is precisely when it is needed, so
 * that one stays enabled.
 */

/** The shell both forms sit in, so the two read as one surface. */
function PendingShell({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <section
      data-slot="pending-question"
      aria-label={label}
      className="mx-auto w-full max-w-3xl px-3 pb-2 sm:px-4"
    >
      <div className="max-h-[min(calc(45dvh/var(--ui-scale,1)),24rem)] overflow-y-auto overscroll-contain rounded-lg border bg-background shadow-sm">
        {children}
      </div>
    </section>
  )
}

export const PendingQuestion = React.memo(function PendingQuestion({
  messageId,
  toolId,
  input,
  disabled,
  onAnswer,
}: {
  messageId: string
  toolId: string
  input?: string
  disabled: boolean
  onAnswer: (messageId: string, toolId: string, result: AskQuestionResult) => void
}) {
  const question = React.useMemo(() => parseAskQuestionInput(input), [input])
  const handleSubmit = React.useCallback(
    (result: AskQuestionResult) => onAnswer(messageId, toolId, result),
    [messageId, toolId, onAnswer]
  )
  if (!question) return null
  return (
    <PendingShell label="Question awaiting your answer">
      <AskQuestion {...question} className="my-0 border-0" disabled={disabled} onSubmit={handleSubmit} />
    </PendingShell>
  )
})

/* -------------------------------------------------------------------------- */
/*                        a running turn's own question                       */
/* -------------------------------------------------------------------------- */

/**
 * ACP marks its affirmative options `allow_once` / `allow_always`; the vendored
 * form reads a trailing "(Recommended)" out of the label. Only the allowing
 * ones are marked — a refusal is a legitimate answer, not a lesser one.
 */
const RECOMMENDED_KINDS = new Set(["allow_once", "allow_always"])

function askItem(request: UserRequest): AskQuestionItem {
  const options = request.options?.length
    ? request.options
    : [
        { id: "confirm", label: "Confirm", kind: "allow_once" },
        { id: "cancel", label: "Cancel" },
      ]
  return {
    id: request.id,
    prompt: request.title,
    options: options.map((option) => ({
      id: option.id,
      label: RECOMMENDED_KINDS.has(option.kind ?? "")
        ? `${option.label} (Recommended)`
        : option.label,
    })),
  }
}

export const PendingUserRequest = React.memo(function PendingUserRequest({
  request,
  onAnswer,
}: {
  request: UserRequest
  /** Resolves the blocked turn; rejects if nothing is waiting any more. */
  onAnswer: (requestId: string, answer: UserRequestAnswer) => Promise<void>
}) {
  /**
   * One answer per request. The row is only replaced once the turn's own
   * stream reports the outcome, which leaves a window where a second click
   * would post again — so the form locks itself and only unlocks if the post
   * came back an error worth retrying.
   */
  const [sending, setSending] = React.useState(false)
  const answer = React.useCallback(
    (value: UserRequestAnswer) => {
      setSending(true)
      void onAnswer(request.id, value).catch(() => setSending(false))
    },
    [onAnswer, request.id]
  )

  if (request.kind === "input") {
    return (
      <PendingShell label="The agent is waiting for your input">
        <UserRequestInput request={request} disabled={sending} onAnswer={answer} />
      </PendingShell>
    )
  }
  return (
    <PendingShell label="The agent is waiting for your answer">
      <UserRequestChoice request={request} disabled={sending} onAnswer={answer} />
    </PendingShell>
  )
})

function UserRequestChoice({
  request,
  disabled,
  onAnswer,
}: {
  request: UserRequest
  disabled: boolean
  onAnswer: (answer: UserRequestAnswer) => void
}) {
  const question = React.useMemo(() => askItem(request), [request])
  const questions = React.useMemo(() => [question], [question])
  const handleSubmit = React.useCallback(
    (result: AskQuestionResult) => {
      const optionId = result.answers[question.id]?.optionIds[0]
      onAnswer(optionId ? { optionId } : { cancelled: true })
    },
    [onAnswer, question.id]
  )
  const handleSkip = React.useCallback(
    () => onAnswer({ cancelled: true }),
    [onAnswer]
  )
  return (
    <div data-slot="pending-request">
      {request.description ? (
        <p
          data-slot="pending-request-detail"
          className="truncate border-b px-3.5 pt-2.5 pb-2 text-[11.5px] text-muted-foreground"
          title={request.description}
        >
          {request.description}
        </p>
      ) : null}
      <AskQuestion
        title={
          request.kind === "permission"
            ? "Permission requested"
            : "The agent needs an answer"
        }
        questions={questions}
        className="my-0 border-0"
        disabled={disabled}
        hideOther
        skipLabel={request.kind === "permission" ? "Deny" : "Cancel"}
        submitLabel="Send"
        onSkip={handleSkip}
        onSubmit={handleSubmit}
      />
    </div>
  )
}

/** The free-text variant: one textarea, ⌘/Ctrl+Enter to send. */
function UserRequestInput({
  request,
  disabled,
  onAnswer,
}: {
  request: UserRequest
  disabled: boolean
  onAnswer: (answer: UserRequestAnswer) => void
}) {
  const [text, setText] = React.useState("")
  const submit = React.useCallback(() => {
    const value = text.trim()
    if (value && !disabled) onAnswer({ text: value })
  }, [disabled, onAnswer, text])

  return (
    <form
      data-slot="pending-request"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      className="flex flex-col gap-2 p-3.5"
    >
      <label
        data-slot="pending-request-prompt"
        htmlFor={`pending-request-${request.id}`}
        className="text-[13px] leading-snug text-foreground"
      >
        {request.title}
      </label>
      {request.description ? (
        <p className="text-[11.5px] text-muted-foreground">{request.description}</p>
      ) : null}
      <textarea
        id={`pending-request-${request.id}`}
        data-slot="pending-request-text"
        autoFocus
        rows={3}
        disabled={disabled}
        value={text}
        placeholder={request.placeholder ?? "Type your answer"}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        }}
        className="min-h-16 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <div
        data-slot="pending-request-actions"
        className="flex items-center justify-end gap-1.5"
      >
        <button
          type="button"
          data-slot="pending-request-cancel"
          disabled={disabled}
          onClick={() => onAnswer({ cancelled: true })}
          className={cn(actionClass, "text-muted-foreground hover:bg-muted hover:text-foreground")}
        >
          Cancel
        </button>
        <button
          type="submit"
          data-slot="pending-request-submit"
          disabled={disabled || !text.trim()}
          className={cn(actionClass, "bg-primary text-primary-foreground hover:bg-primary/90")}
        >
          Send
        </button>
      </div>
    </form>
  )
}

const actionClass =
  "h-8 rounded-md px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
