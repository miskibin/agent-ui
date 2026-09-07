import {
  formatAskQuestionOutput,
  isOpenAskTool,
  parseAskQuestionInput,
  type AskQuestionResult,
} from "@/components/ui/ask-question"
import type { MessageToolCallData } from "@/components/ui/message"
import { toolsFromParts } from "@/lib/message-stream"
import type { StoredMessage } from "@/lib/store/types"
import {
  isOpenUserRequestTool,
  parseUserRequestInput,
  type UserRequest,
} from "@/lib/turn-requests"

/**
 * The ask-question tool is the one tool the *user* answers, so the transcript
 * is rewritten in place when they do — or when they type on past it. The
 * answer is replayed to the model as a user turn, which is why it also needs
 * to be recognisable as one the app wrote rather than one that was typed.
 */

/** How an answered Ask Question block is handed back to the model. */
export const ASK_ANSWER_PREFIX = "AskQuestion result: "
export const ASK_ANSWER_SKIPPED = `${ASK_ANSWER_PREFIX}skipped`

/** The tool calls of one stored message, however that message stores them. */
function toolsOf(message: StoredMessage): MessageToolCallData[] {
  return message.tools?.length
    ? message.tools
    : toolsFromParts(message.parts ?? [])
}

/**
 * Only the latest turn can still be waiting on an answer — matching the row
 * `MessageList` offers a form for. An unanswered ask further back is history,
 * and picking it up here would rewrite a stored transcript the user closed
 * long ago.
 *
 * The parse guard is part of "pending": `isOpenAskTool` lets a *running* ask
 * through before its arguments have finished streaming, and a row the form
 * cannot render is not something the user can answer — counting it would put
 * a chat on the dock badge with nothing to show for it.
 */
export function findPendingAsk(messages: StoredMessage[]) {
  const message = messages.at(-1)
  if (!message) return null
  const tool = toolsOf(message).find(
    (candidate) => isOpenAskTool(candidate) && parseAskQuestionInput(candidate.input)
  )
  return tool ? { messageId: message.id, toolId: tool.id, input: tool.input } : null
}

/**
 * The two shapes a chat can be waiting on, and the two ways they are answered.
 *
 * `ask` is the AskQuestion tool: the turn is over, the transcript is rewritten
 * in place and the answer is replayed as a new turn. `request` is a turn that
 * is still *running* and blocked on us (`lib/turn-requests`) — the answer goes
 * to `POST /api/chat/respond` and the row updates itself off the same stream.
 */
export type PendingAsk = {
  kind: "ask"
  messageId: string
  toolId: string
  input?: string
}

export type PendingUserRequest = {
  kind: "request"
  messageId: string
  toolId: string
  request: UserRequest
}

export type PendingThreadRequest = PendingAsk | PendingUserRequest

/**
 * What the open chat owes an answer to, if anything. A live request wins over
 * an ask: it is the one holding a subprocess open, and only one form is ever
 * shown above the composer.
 */
export function findPendingRequest(
  messages: StoredMessage[]
): PendingThreadRequest | null {
  const message = messages.at(-1)
  if (!message) return null
  const tools = toolsOf(message)
  for (const tool of tools) {
    if (!isOpenUserRequestTool(tool)) continue
    const request = parseUserRequestInput(tool.input)
    if (request) {
      return { kind: "request", messageId: message.id, toolId: tool.id, request }
    }
  }
  const ask = findPendingAsk(messages)
  return ask ? { kind: "ask", ...ask } : null
}

/** Marks one ask block answered (or skipped), in both `tools` and `parts`. */
export function completeAsk(
  messages: StoredMessage[],
  messageId: string,
  toolId: string,
  result: AskQuestionResult
): StoredMessage[] {
  const output = formatAskQuestionOutput(result)
  return messages.map((message) => {
    if (message.id !== messageId) return message
    const patchTool = (tool: MessageToolCallData) =>
      tool.id === toolId ? { ...tool, status: "done" as const, output } : tool
    return {
      ...message,
      tools: message.tools?.map(patchTool),
      parts: message.parts?.map((part) =>
        part.type === "tool" && part.tool.id === toolId
          ? { ...part, tool: patchTool(part.tool) }
          : part
      ),
    }
  })
}

/**
 * A turn the app wrote for the model, not one the user typed. The flag is
 * authoritative; the prefix match covers threads stored before it existed,
 * and is narrow enough that a real prompt cannot trip it.
 */
export function isInternalMessage(message: StoredMessage) {
  if (message.internal) return true
  return (
    message.sender === "user" &&
    (message.content === ASK_ANSWER_SKIPPED ||
      message.content.startsWith(`${ASK_ANSWER_PREFIX}{`))
  )
}
