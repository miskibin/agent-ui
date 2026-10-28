import { base64FromDataUrl } from "@/lib/attachments"
import type { ChatTurn } from "@/lib/providers/types"
import type { StoredMessage } from "@/lib/store/types"

export const MAX_REPLAY_MESSAGES = 200
export const MAX_REPLAY_CHARACTERS = 512_000
const MAX_REPLAY_IMAGE_CHARACTERS = 16 * 1024 * 1024
/** Distinct tool names listed for a turn that said nothing in words. */
const MAX_TOOL_NAMES = 6
const MAX_TOOL_INPUT_CHARS = 160

/**
 * What an assistant turn did, for a turn whose answer text is empty — the
 * shape a *stopped* turn usually has: tool calls and thinking, no prose. A
 * replay that skips it makes the next "continue" read as the first message of
 * a chat, which is the bug this exists for.
 */
export function describeToolOnlyTurn(message: StoredMessage): string | undefined {
  const tools = (message.parts ?? []).flatMap((part) =>
    part.type === "tool" ? [part.tool] : []
  )
  if (tools.length === 0) return undefined
  const names = [...new Set(tools.map((tool) => tool.name))].slice(0, MAX_TOOL_NAMES)
  const last = tools[tools.length - 1]
  const lastInput = last.input?.replace(/\s+/g, " ").trim()
  return [
    `(No written answer — this turn was cut short after ${tools.length} tool call${tools.length === 1 ? "" : "s"}: ${names.join(", ")}.`,
    lastInput
      ? ` The last one${last.status === "done" ? "" : " had not finished"}: ${lastInput.slice(0, MAX_TOOL_INPUT_CHARS)}.)`
      : ")",
  ].join("")
}

/**
 * The stored transcript as the newest bounded window a backend can be briefed
 * with. Durable history and model context are separate budgets: a stateless
 * provider gets this instead of an unbounded transcript (and every historical
 * base64 image) on each request.
 */
export function replayHistory(
  messages: StoredMessage[],
  vision: boolean
): ChatTurn[] {
  const selected: ChatTurn[] = []
  let characters = 0
  let imageCharacters = 0

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    const isUser = message.sender === "user"
    const content =
      message.content.trim() || isUser
        ? message.content
        : (describeToolOnlyTurn(message) ?? "")
    if (!content.trim() && !message.attachments?.length) continue
    if (selected.length >= MAX_REPLAY_MESSAGES) break
    if (selected.length > 0 && characters + content.length > MAX_REPLAY_CHARACTERS) {
      break
    }

    const images: string[] = []
    if (vision) {
      for (const attachment of message.attachments ?? []) {
        const image = base64FromDataUrl(attachment.url)
        if (imageCharacters + image.length > MAX_REPLAY_IMAGE_CHARACTERS) break
        imageCharacters += image.length
        images.push(image)
      }
    }

    characters += content.length
    selected.push({
      role: isUser ? "user" : "assistant",
      content,
      ...(images.length ? { images } : null),
    })
  }

  selected.reverse()
  while (selected[0]?.role === "assistant") selected.shift()
  return selected
}
