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

const viewCache = new WeakMap<StoredMessage, StoredMessage>()

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
      const input = object(tool.input)
      const result = receipt(tool.output)
      // The CLI prints a JSON receipt as the output of pi's shell tool. Only
      // identify a delegation when both the command and receipt agree; other
      // shell commands and status calls must remain ordinary tool rows.
      const command = typeof input.command === "string" ? input.command : ""
      const isCli = /(?:^|[\s/\\])agent-ui(?:\.mjs)?\s+run\s/.test(command)
        && typeof result.run_id === "string" && typeof result.session_id === "string"
      if (!isNative && !isCli && !/(?:^|__)run_subagent$/.test(tool.name)) continue
      const sessionId = typeof result.session_id === "string" ? result.session_id : undefined
      const run = sessionId ? runs[sessionId] : Object.values(runs).find((run) => run.prompt === input.prompt)
      const snapshot = native.find((agent) => agent.parentToolId === tool.id)
      const id = encodeURIComponent(JSON.stringify([message.id, tool.id]))
      cards.set(id, {
        id,
        title: snapshot?.title ?? run?.title ?? (typeof result.title === "string" ? result.title : typeof input.title === "string" ? input.title : typeof input.description === "string" ? input.description : "Delegated task"),
        status: snapshot?.status ?? run?.status ?? (result.status === "running" || result.status === "queued" ? "unknown" : typeof result.status === "string" ? result.status : tool.status) ?? "unknown",
        harness: isNative ? "Claude Code" : run?.harness ?? (typeof result.harness === "string" ? result.harness : typeof input.harness === "string" ? input.harness : "Agent"),
        model: snapshot?.model ?? run?.model ?? (typeof result.model === "string" ? result.model : undefined),
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

/** Only active delegations belong in the live transcript, never in answer text. */
export function activeSubagentCards(cards: Map<string, SubagentCardData>) {
  return [...cards.values()].filter((card) => card.status === "running" || card.status === "queued")
}

/** Hide internal transport snapshots; retain real tool calls in folded history. */
export function withoutSubagentSnapshots(message: StoredMessage): StoredMessage {
  if (!message.tools?.some((tool) => tool.name === NATIVE_AGENT_TOOL) &&
      !message.parts?.some((part) => part.type === "tool" && part.tool.name === NATIVE_AGENT_TOOL)) return message
  const cached = viewCache.get(message)
  if (cached) return cached
  const value: StoredMessage = {
    ...message,
    tools: message.tools?.filter((tool) => tool.name !== NATIVE_AGENT_TOOL),
    parts: message.parts?.filter((part) => part.type !== "tool" || part.tool.name !== NATIVE_AGENT_TOOL),
  }
  viewCache.set(message, value)
  return value
}
