/**
 * Agent Client Protocol (ACP) v1 wire types — the subset an ACP *client* needs.
 *
 * ACP is JSON-RPC 2.0 over newline-delimited stdio: the client spawns the agent
 * and both sides send requests. Property keys are camelCase, discriminator
 * values snake_case, and every path in the protocol is absolute.
 *
 * These are hand-written rather than pulled from `@agentclientprotocol/sdk`:
 * the SDK is 5.6 MB of Zod schemas, and this app's rule is no new runtime
 * dependency without a strong reason. Pure types — nothing here imports
 * `node:child_process`, so `lib/acp-runtime.ts` stays spawn-free too.
 */

export const ACP_PROTOCOL_VERSION = 1

export type JsonRpcId = number | string

export type JsonRpcError = { code: number; message: string; data?: unknown }

export type JsonRpcMessage = {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: JsonRpcError
}

/** Errors the client is expected to speak. */
export const ACP_ERROR = {
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  resourceNotFound: -32002,
} as const

/**
 * A JSON-RPC error, in either direction: raised by the client's own handlers to
 * refuse an agent's request, and thrown by the transport when an agent refuses
 * ours. It lives here rather than in `lib/acp-agent.ts` so the provider layer
 * can throw one without pulling `node:child_process` into its import graph.
 */
export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = "AcpRpcError"
  }
}

export type AcpContentBlock = {
  type?: string
  text?: string
  /** `resource_link` / `resource` carry a uri instead of text. */
  uri?: string
  resource?: { uri?: string; text?: string; mimeType?: string }
}

export type AcpSessionCapabilities = {
  resume?: unknown
  close?: unknown
  list?: unknown
  delete?: unknown
}

export type AcpAgentCapabilities = {
  loadSession?: boolean
  promptCapabilities?: {
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  }
  sessionCapabilities?: AcpSessionCapabilities
}

export type AcpInitializeResult = {
  protocolVersion?: number
  agentInfo?: { name?: string; title?: string; version?: string }
  agentCapabilities?: AcpAgentCapabilities
  authMethods?: Array<{ id?: string }>
}

/**
 * ACP has no "list models" RPC. Agents expose selectable settings — model,
 * reasoning effort — as `configOptions` on the `session/new` result, whose
 * option `value`s are opaque strings the client echoes back verbatim (dsh's
 * are JSON `"[provider,model]"` pairs).
 */
export type AcpConfigChoice = {
  value?: string
  name?: string
  description?: string
  /** Grouped choices nest a second level under the same key. */
  group?: string
  options?: AcpConfigChoice[]
}

export type AcpConfigOption = {
  id?: string
  name?: string
  category?: string
  type?: string
  currentValue?: string
  options?: AcpConfigChoice[]
}

export type AcpSessionNewResult = {
  sessionId?: string
  configOptions?: AcpConfigOption[]
}

export type AcpSessionResumeResult = { configOptions?: AcpConfigOption[] }

export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed"

/**
 * `{type:"content"}` is the only variant observed from dsh, but `diff` and
 * `terminal` are part of v1 and other agents emit them.
 */
export type AcpToolCallContent = {
  type?: string
  content?: AcpContentBlock
  path?: string
  oldText?: string | null
  newText?: string
  terminalId?: string
}

export type AcpPlanEntry = {
  content?: string
  priority?: string
  status?: string
}

export type AcpSessionUpdate = {
  sessionUpdate?: string
  /** message chunks */
  messageId?: string
  content?: AcpContentBlock | AcpToolCallContent[]
  /** tool_call / tool_call_update */
  toolCallId?: string
  title?: string
  kind?: string
  status?: AcpToolCallStatus
  rawInput?: unknown
  /**
   * The tool's own structured result. v1 leaves the shape to the agent, so
   * the app reads exactly one thing out of it: a process exit code, when a
   * shell-shaped tool published one.
   */
  rawOutput?: unknown
  /** plan */
  entries?: AcpPlanEntry[]
}

export type AcpSessionUpdateParams = {
  sessionId?: string
  update?: AcpSessionUpdate
}

export type AcpPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always"

export type AcpPermissionOption = {
  optionId?: string
  name?: string
  kind?: AcpPermissionOptionKind | string
}

/**
 * `toolCall` carries **only** `toolCallId` in practice — no title, no input —
 * so a client that wants to know what it is approving must correlate against
 * the `tool_call` update it already received.
 */
export type AcpRequestPermissionParams = {
  sessionId?: string
  toolCall?: { toolCallId?: string }
  options?: AcpPermissionOption[]
}

export type AcpReadTextFileParams = {
  sessionId?: string
  path?: string
  line?: number
  limit?: number
}

export type AcpWriteTextFileParams = {
  sessionId?: string
  path?: string
  content?: string
}

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"

export type AcpPromptResult = { stopReason?: AcpStopReason | string }
