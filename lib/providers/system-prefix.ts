import type { ChatTurn } from "@/lib/providers/types"

/**
 * How out-of-band context reaches a backend that has no system role.
 *
 * The CLI harnesses (`cursor-agent`, `pi`, ACP) take exactly one string per
 * turn — `args.push("--", prompt)` — so anything the app wants to say out of
 * band has to ride in front of the prompt. The fences keep it legible as
 * context rather than as something the user typed, which matters because the
 * agent's own answer will otherwise start explaining the block back at them.
 *
 * Two blocks, two fences, one fixed order, and each is emitted at most once —
 * they come from two mechanisms that must not blur together:
 *
 *   `<context>`  standing context: the generative-view vocabulary (when
 *                `chat.generativeViews` is on) and the durable user memory
 *                from `lib/memory`, the same in every chat, sent once per
 *                backend conversation.
 *   `<handoff>`  turn context: what other agents did in *this* chat since the
 *                one about to run last looked (`lib/handoff`), sent on every
 *                turn it exists — including resumed ones, which is exactly
 *                when a returning agent needs it.
 *
 * Neither ever touches the stored user message: what the user typed is what
 * gets persisted and shown.
 */
export type PromptContext = {
  standingContext?: string
  turnContext?: string
  /**
   * The chat so far, for a harness that is starting a *fresh* backend
   * conversation in a chat that already has one. Ignored once `sessionId` is
   * set: a resumed session already holds everything it was told.
   */
  history?: ChatTurn[]
  sessionId?: string
}

/** The transcript fenced in front of the prompt, oldest first. */
export function conversationHistoryBlock(history: ChatTurn[] | undefined) {
  const turns = (history ?? []).filter((turn) => turn.content.trim())
  if (turns.length === 0) return undefined
  const lines = turns.map(
    (turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content.trim()}`
  )
  return [
    "<conversation-history>",
    "This chat started before this session — the previous session was lost or cut off. What was said so far, oldest first. Carry on from it; do not ask the user to repeat it.",
    "",
    lines.join("\n\n"),
    "</conversation-history>",
  ].join("\n")
}

export function withPromptContext(prompt: string, context: PromptContext) {
  const standing = context.standingContext?.trim()
  const turn = context.turnContext?.trim()
  const blocks: string[] = []
  if (standing) blocks.push(`<context>\n${standing}\n</context>`)
  if (turn) blocks.push(`<handoff>\n${turn}\n</handoff>`)
  const replay = context.sessionId ? undefined : conversationHistoryBlock(context.history)
  if (replay) blocks.push(replay)
  if (blocks.length === 0) return prompt
  return `${blocks.join("\n\n")}\n\n${prompt}`
}
