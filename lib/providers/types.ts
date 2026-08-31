import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import type { ModelOption } from "@/components/ui/model-picker"

export type { AgentStreamEvent }

/** What a provider can do — the UI degrades gracefully per flag. */
export type ProviderCapabilities = {
  /** Full agentic runs: tool calls, file edits. */
  tools: boolean
  /** Server-side conversation resume via sessionId. */
  resume: boolean
  /** Reasoning-effort selection is meaningful. */
  effort: boolean
  /** Accepts image attachments. */
  vision: boolean
}

export type ProviderInfo = {
  id: string
  name: string
  description: string
  capabilities: ProviderCapabilities
  /** False when the backend is unreachable/disabled — shown in pickers. */
  available: boolean
  /** Why unavailable, for the UI. */
  unavailableReason?: string
}

export type AgentRunOptions = {
  prompt: string
  model: string
  /** Provider-side session to resume, if capabilities.resume. */
  sessionId?: string
  effort?: string
  signal: AbortSignal
}

/**
 * Server-side provider. Implementations live in lib/providers/*, are
 * registered in lib/providers/registry.ts, and stream the shared
 * AgentStreamEvent protocol consumed by the chat UI.
 */
export type AgentProvider = {
  info(): Promise<ProviderInfo>
  listModels(): Promise<ModelOption[]>
  run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent>
}
