import type { StoredMessage } from "@/lib/store/types"

/** An ordinary tool envelope keeps provider-specific activity on the existing wire. */
export const NATIVE_AGENT_TOOL = "agent_ui_native_subagent"

export type NativeAgentSnapshot = {
  parentToolId: string
  model?: string
  text: string
  tools: { id: string; name: string; status: string; input?: string; output?: string }[]
}

export function nativeAgents(messages: StoredMessage[]) {
  return messages.flatMap((message) => (message.tools ?? []).flatMap((tool) => {
    if (tool.name !== NATIVE_AGENT_TOOL || !tool.output) return []
    try {
      const snapshot = JSON.parse(tool.output) as NativeAgentSnapshot
      if (typeof snapshot.parentToolId !== "string" || typeof snapshot.text !== "string" || !Array.isArray(snapshot.tools)) return []
      const parent = message.tools?.find((item) => item.id === snapshot.parentToolId)
      let title = "Claude subagent"
      let prompt = ""
      try {
        const input = JSON.parse(parent?.input || "{}")
        if (typeof input.description === "string") title = input.description
        else if (typeof input.subagent_type === "string") title = input.subagent_type
        if (typeof input.prompt === "string") prompt = input.prompt
      } catch { /* Older harnesses may send plain text input. */ }
      return [{ ...snapshot, id: `${message.id}:${tool.id}`, title, prompt, status: tool.status }]
    } catch { return [] }
  }))
}

/** Activity is rendered in the Agents panel, never as JSON in the transcript. */
export function withoutNativeActivity(message: StoredMessage): StoredMessage {
  if (!message.tools?.some((tool) => tool.name === NATIVE_AGENT_TOOL)) return message
  return {
    ...message,
    tools: message.tools.filter((tool) => tool.name !== NATIVE_AGENT_TOOL),
    parts: message.parts?.filter((part) => part.type !== "tool" || part.tool.name !== NATIVE_AGENT_TOOL),
  }
}
