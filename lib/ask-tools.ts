import {
  formatAskQuestionOutput,
  isOpenAskTool,
  type AskQuestionResult,
} from "@/components/ui/ask-question"
import type { MessageToolCallData } from "@/components/ui/message"
import { toolsFromParts } from "@/lib/message-stream"
import type { StoredMessage } from "@/lib/store/types"

/**
 * The ask-question tool is the one tool the *user* answers, so the transcript
 * is rewritten in place when they do — or when they type on past it. The
 * answer is replayed to the model as a user turn, which is why it also needs
 * to be recognisable as one the app wrote rather than one that was typed.
 */

/** How an answered Ask Question block is handed back to the model. */
export const ASK_ANSWER_PREFIX = "AskQuestion result: "
export const ASK_ANSWER_SKIPPED = `${ASK_ANSWER_PREFIX}skipped`

/**
 * Only the latest turn can still be waiting on an answer — matching the row
 * `MessageList` offers a form for. An unanswered ask further back is history,
 * and picking it up here would rewrite a stored transcript the user closed
 * long ago.
 */
export function findPendingAsk(messages: StoredMessage[]) {
  const message = messages.at(-1)
  if (!message) return null
  const tools = message.tools?.length
    ? message.tools
    : toolsFromParts(message.parts ?? [])
  const tool = tools.find(isOpenAskTool)
  return tool ? { messageId: message.id, toolId: tool.id } : null
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
