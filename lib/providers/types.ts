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

export type ChatTurn = {
  role: "user" | "assistant"
  content: string
  /** Base64 image payloads (no `data:` prefix) attached to this turn, for
   *  providers that replay history — only meaningful when `capabilities.vision`. */
  images?: string[]
}

export type AgentRunOptions = {
  prompt: string
  model: string
  /**
   * Out-of-band context for this turn — today, the user memory block from
   * `lib/memory`. Providers with a real system role (Ollama) send it as one;
   * the CLI harnesses, which accept a single prompt string, fence it in front
   * of the prompt via `withSystemPrefix`.
   *
   * The chat route sends it once per backend conversation for providers with
   * `capabilities.resume` — repeating it every turn would re-send context the
   * backend already has — and on every turn for the stateless ones.
   */
  system?: string
  /** Provider-side session to resume, if capabilities.resume. */
  sessionId?: string
  effort?: string
  /**
   * Prior turns of this thread, oldest first, excluding `prompt`.
   *
   * Stateless backends (Ollama) have no `sessionId` to resume, so the chat
   * route replays the stored transcript instead. Providers with
   * `capabilities.resume` ignore it — the backend already has the context.
   */
  history?: ChatTurn[]
  /** Base64 image payloads (no `data:` prefix) attached to `prompt`, when
   *  `capabilities.vision`. */
  images?: string[]
  /**
   * Absolute working folder for this run — the chat's own folder, chosen in
   * the header. Providers that spawn a CLI use it as the process cwd (and so
   * as the sandbox the agent reads and writes in); ones that do not, ignore it.
   */
  cwd?: string
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
  /**
   * Ids from `listModels()` that actually accept image input. Only providers
   * with `capabilities.vision` need to implement this — others are never
   * asked. Omit it and every model is treated as vision-incapable.
   */
  visionModels?(): Promise<string[]>
}
