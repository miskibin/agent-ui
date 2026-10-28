import type { StoredMessage } from "@/lib/store/types"
import { nativeAgents, NATIVE_AGENT_TOOL } from "@/lib/subagents/native"
import type { SubagentRunSummary } from "@/lib/subagents/types"

export type SubagentCardData = {
  id: string
  title: string
  status: string
  harness: string
  model?: string
  sessionId?: string
  prompt?: string
  text?: string
  tools: ReturnType<typeof nativeAgents>[number]["tools"]
  run?: SubagentRunSummary
}

export const CARD_PATTERN = /\uE000subagent:([^\uE001]+)\uE001/g
const viewCache = new WeakMap<StoredMessage, { signature: string; value: StoredMessage }>()

function object(text?: string): Record<string, unknown> {
  try { return JSON.parse(text || "{}") ?? {} } catch { return {} }
}

/** MCP clients may return structured JSON directly or wrap it in text content. */
function receipt(text?: string): Record<string, unknown> {
  const value = object(text)
  if (value.structuredContent && typeof value.structuredContent === "object") return value.structuredContent as Record<string, unknown>
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (typeof item?.text === "string") {
        const parsed = object(item.text)
        if (typeof parsed.session_id === "string") return parsed
      }
    }
  }
  return value
}

export function subagentCards(messages: StoredMessage[], runs: Record<string, SubagentRunSummary>) {
  const cards = new Map<string, SubagentCardData>()
  const hidden = new Map<string, Set<string>>()
  for (const message of messages) {
    if (message.sender !== "assistant") continue
    const native = nativeAgents([message])
    const tools = message.tools ?? message.parts?.flatMap((part) => part.type === "tool" ? [part.tool] : []) ?? []
    const ids = new Set<string>()
    for (const tool of tools) {
      if (tool.name === NATIVE_AGENT_TOOL) { ids.add(tool.id); continue }
      const isNative = tool.name === "Agent" || tool.name === "Task"
      if (!isNative && !/(?:^|__)run_subagent$/.test(tool.name)) continue
      const input = object(tool.input)
      const result = receipt(tool.output)
      const sessionId = typeof result.session_id === "string" ? result.session_id : undefined
      const run = sessionId ? runs[sessionId] : Object.values(runs).find((run) => run.prompt === input.prompt)
      const snapshot = native.find((agent) => agent.parentToolId === tool.id)
      const id = encodeURIComponent(JSON.stringify([message.id, tool.id]))
      cards.set(id, {
        id,
        title: snapshot?.title ?? (typeof input.title === "string" ? input.title : typeof input.description === "string" ? input.description : "Delegated task"),
        status: snapshot?.status ?? run?.status ?? (typeof result.status === "string" ? result.status : tool.status) ?? "unknown",
        harness: isNative ? "Claude Code" : typeof input.harness === "string" ? input.harness : "Agent",
        model: snapshot?.model ?? run?.model,
        sessionId: sessionId ?? run?.sessionId,
        prompt: snapshot?.prompt ?? (typeof input.prompt === "string" ? input.prompt : undefined),
        text: snapshot?.text ?? (typeof result.answer === "string" ? result.answer : isNative ? tool.output : undefined),
        tools: snapshot?.tools ?? [], run,
      })
      ids.add(tool.id)
      for (const child of snapshot?.tools ?? []) ids.add(child.id)
    }
    // Some CLI versions report child output before publishing the Agent input.
    for (const agent of native) {
      const id = encodeURIComponent(JSON.stringify([message.id, agent.parentToolId]))
      if (!cards.has(id)) cards.set(id, { ...agent, id, status: agent.status ?? "unknown", harness: "Claude Code" })
    }
    if (ids.size) hidden.set(message.id, ids)
  }
  return { cards, hidden }
}

/** View-only markers use MessageMarkdown's public pattern renderer. Never stored or sent. */
export function withSubagentCards(message: StoredMessage, cards: Map<string, SubagentCardData>, hidden: Map<string, Set<string>>): StoredMessage {
  const ids = hidden.get(message.id)
  const owned = [...cards.keys()].filter((id) => JSON.parse(decodeURIComponent(id))[0] === message.id)
  if (!owned.length) return message
  const signature = JSON.stringify([owned, [...(ids ?? [])]])
  const cached = viewCache.get(message)
  if (cached?.signature === signature) return cached.value
  const parts = message.parts ?? [
    ...(message.tools ?? []).map((tool) => ({ type: "tool" as const, id: tool.id, tool })),
    { type: "text" as const, id: `${message.id}:text`, text: message.content },
  ]
  const value: StoredMessage = {
    ...message,
    tools: message.tools?.filter((tool) => !ids?.has(tool.id)),
    parts: [
      ...parts.filter((part) => part.type !== "tool" || !ids?.has(part.tool.id)),
      ...owned.map((id) => ({ type: "text" as const, id: `card:${id}`, text: `\uE000subagent:${id}\uE001` })),
    ],
  }
  viewCache.set(message, { signature, value })
  return value
}
