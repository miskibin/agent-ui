"use client"

import * as React from "react"

import { AskQuestion, parseAskQuestionInput, type AskQuestionResult } from "@/components/ui/ask-question"

/** A single answerable form outside the transcript's scrolling surface. */
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
    <section
      data-slot="pending-question"
      aria-label="Question awaiting your answer"
      className="mx-auto w-full max-w-3xl px-3 pb-2 sm:px-4"
    >
      <div className="max-h-[min(calc(45dvh/var(--ui-scale,1)),24rem)] overflow-y-auto overscroll-contain rounded-lg border bg-background shadow-sm">
        <AskQuestion {...question} className="my-0 border-0" disabled={disabled} onSubmit={handleSubmit} />
      </div>
    </section>
  )
})
