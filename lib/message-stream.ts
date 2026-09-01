import type { MessagePart, MessageToolCallData } from "@/components/ui/message"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import { linkLocalImages } from "@/lib/local-media"
import type { StoredMessage } from "@/lib/store/types"

/**
 * The event → message reducer, shared by the browser (optimistic rendering)
 * and `app/api/chat` (what actually gets persisted). Both sides run the exact
 * same folds, so a reload of a thread looks identical to the live stream.
 *
 * Every helper is pure and free of component/runtime imports (types only) so
 * the server route can pull it in without dragging client code along.
 */

export function textFromParts(parts: MessagePart[]) {
  let text = ""
  for (const part of parts) {
    if (part.type === "text") text += part.text
  }
  return text
}

export function toolsFromParts(parts: MessagePart[]) {
  const tools: MessageToolCallData[] = []
  for (const part of parts) {
    if (part.type === "tool") tools.push(part.tool)
  }
  return tools
}

/**
 * Appends to the tail text part when there is one. Local-image detection only
 * runs when a chunk can actually close a markdown target; ordinary token
 * deltas avoid rescanning the accumulated answer.
 *
 * The rewrite of local image paths happens here, on the accumulated tail
 * rather than the delta, because a path arrives in pieces: `![](C:\Users\m`
 * matches nothing and is left as text until its closing paren lands. Doing it
 * in the shared reducer is what keeps a reloaded thread identical to the live
 * stream — both sides fold the same way.
 */
export function appendTextPart(
  parts: MessagePart[],
  text: string
): MessagePart[] {
  const last = parts.at(-1)
  if (last?.type === "text") {
    const combined = last.text + text
    const nextText =
      text.includes(")") && combined.includes("![")
        ? linkLocalImages(combined)
        : combined
    return [
      ...parts.slice(0, -1),
      { ...last, text: nextText },
    ]
  }
  return [...parts, { type: "text", id: newId(), text: linkLocalImages(text) }]
}

export function appendThinkingPart(
  parts: MessagePart[],
  text: string
): MessagePart[] {
  const last = parts.at(-1)
  if (last?.type === "thinking") {
    return [...parts.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...parts, { type: "thinking", id: newId(), text }]
}

/** Tool events arrive twice (`running` then `done`/`error`) under one id. */
export function upsertToolPart(
  parts: MessagePart[],
  tool: MessageToolCallData
): MessagePart[] {
  const index = parts.findIndex(
    (part) => part.type === "tool" && part.tool.id === tool.id
  )
  if (index < 0) return [...parts, { type: "tool", id: tool.id, tool }]

  const next = [...parts]
  const existing = next[index]
  if (existing.type === "tool") {
    next[index] = {
      type: "tool",
      id: existing.id,
      tool: {
        ...existing.tool,
        ...tool,
        input: tool.input ?? existing.tool.input,
        output: tool.output ?? existing.tool.output,
      },
    }
  }
  return next
}

/**
 * Folds one stream event into an assistant message. `session`, `done` and
 * `error` carry run-level information and are handled by the caller.
 */
export function applyStreamEvent(
  message: StoredMessage,
  event: AgentStreamEvent
): StoredMessage {
  const parts = message.parts ?? []
  if (event.type === "thinking") {
    return { ...message, parts: appendThinkingPart(parts, event.text) }
  }
  if (event.type === "text") {
    const previousTail = parts.at(-1)
    const nextParts = appendTextPart(parts, event.text)
    const nextTail = nextParts.at(-1)
    const content =
      previousTail?.type === "text" && nextTail?.type === "text"
        ? nextTail.text.startsWith(previousTail.text)
          ? message.content + nextTail.text.slice(previousTail.text.length)
          : textFromParts(nextParts)
        : message.content + (nextTail?.type === "text" ? nextTail.text : event.text)
    return { ...message, parts: nextParts, content }
  }
  if (event.type === "tool") {
    const nextParts = upsertToolPart(parts, {
        id: event.id,
        name: event.name,
        status: event.status,
        input: event.input,
        output: event.output,
      })
    return { ...message, parts: nextParts, tools: toolsFromParts(nextParts) }
  }
  return message
}

/** Empty assistant turn the reducer streams into. */
export function seedAssistantMessage(id: string): StoredMessage {
  return { id, content: "", sender: "assistant", tools: [], parts: [] }
}

/** `crypto.randomUUID` is global in browsers and Node ≥ 19. */
export function newId() {
  return crypto.randomUUID()
}

const TITLE_LENGTH = 48

/**
 * First line of the opening prompt, trimmed to a sidebar-sized title. Shared
 * so the client's optimistic rename matches what the chat route persists.
 */
export function deriveSessionTitle(prompt: string) {
  const line = prompt.replace(/\s+/g, " ").trim()
  return line.length > TITLE_LENGTH
    ? `${line.slice(0, TITLE_LENGTH - 1)}…`
    : line
}
