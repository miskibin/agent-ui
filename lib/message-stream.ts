import type { MessagePart, MessageToolCallData } from "@/components/ui/message"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
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
  return parts
    .filter(
      (part): part is Extract<MessagePart, { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text)
    .join("")
}

export function toolsFromParts(parts: MessagePart[]) {
  return parts
    .filter(
      (part): part is Extract<MessagePart, { type: "tool" }> =>
        part.type === "tool"
    )
    .map((part) => part.tool)
}

/** Appends to the tail text part when there is one — keeps streaming O(1). */
export function appendTextPart(
  parts: MessagePart[],
  text: string
): MessagePart[] {
  const last = parts.at(-1)
  if (last?.type === "text") {
    return [...parts.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...parts, { type: "text", id: newId(), text }]
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

/** Rebuilds the flattened `content` / `tools` mirrors after a parts change. */
function withParts(message: StoredMessage, parts: MessagePart[]): StoredMessage {
  return {
    ...message,
    parts,
    content: textFromParts(parts),
    tools: toolsFromParts(parts),
  }
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
    return withParts(message, appendThinkingPart(parts, event.text))
  }
  if (event.type === "text") {
    return withParts(message, appendTextPart(parts, event.text))
  }
  if (event.type === "tool") {
    return withParts(
      message,
      upsertToolPart(parts, {
        id: event.id,
        name: event.name,
        status: event.status,
        input: event.input,
        output: event.output,
      })
    )
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
