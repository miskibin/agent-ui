import type { AgentStreamEvent, PermissionMode } from "@/lib/providers/types"

type RecordValue = Record<string, unknown>

export function sandboxFor(mode: PermissionMode) {
  return mode === "read-only"
    ? "read-only"
    : mode === "full"
      ? "danger-full-access"
      : "workspace-write"
}

export function translateCodexNotification(message: unknown): AgentStreamEvent[] {
  const envelope = record(message)
  const params = record(envelope?.params)
  if (!envelope || !params) return []
  switch (envelope.method) {
    case "item/agentMessage/delta":
      return textEvent("text", params.delta)
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return textEvent("thinking", params.delta)
    case "item/started":
      return toolEvent(params.item, "running")
    case "item/completed":
      return toolEvent(params.item, toolStatus(params.item))
    case "turn/completed": {
      const turn = record(params.turn)
      if (turn?.status === "failed") {
        const error = record(turn.error)
        return [{ type: "error", message: text(error?.message) ?? "Codex turn failed" }]
      }
      if (turn?.status === "interrupted") {
        return [{ type: "error", message: "Codex turn interrupted" }]
      }
      return []
    }
    default:
      return []
  }
}

export function usageFromNotification(message: unknown) {
  const envelope = record(message)
  if (envelope?.method !== "thread/tokenUsage/updated") return undefined
  const total = record(record(record(envelope.params)?.tokenUsage)?.last)
  if (!total) return undefined
  return {
    input: number(total.inputTokens),
    output: number(total.outputTokens),
    cachedInputTokens: number(total.cachedInputTokens),
    cacheCreationTokens: number(total.cacheWriteInputTokens),
    reasoningTokens: number(total.reasoningOutputTokens),
    contextWindow: number(record(record(envelope.params)?.tokenUsage)?.modelContextWindow),
  }
}

function toolEvent(itemValue: unknown, status: "running" | "done" | "error"): AgentStreamEvent[] {
  const item = record(itemValue)
  const id = text(item?.id)
  const type = text(item?.type)
  if (!item || !id || !type) return []
  if (type === "commandExecution") {
    return [{ type: "tool", id, name: "Shell", status, input: JSON.stringify({ command: text(item.command) ?? "", cwd: text(item.cwd) }), output: text(item.aggregatedOutput), ...(number(item.exitCode) === undefined ? null : { exitCode: number(item.exitCode) }) }]
  }
  if (type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : []
    return changes.flatMap((change, index) => {
      const value = record(change)
      const filePath = text(value?.path)
      if (!filePath) return []
      return [{ type: "tool" as const, id: `${id}:${index}`, name: "ApplyPatch", status, input: JSON.stringify({ path: filePath, diff: text(value?.diff) ?? "" }) }]
    })
  }
  if (type === "mcpToolCall") return [{ type: "tool", id, name: `${text(item.server) ?? "mcp"}/${text(item.tool) ?? "tool"}`, status, input: JSON.stringify(item.arguments ?? {}), output: item.result == null ? undefined : JSON.stringify(item.result) }]
  if (type === "dynamicToolCall") return [{ type: "tool", id, name: text(item.tool) ?? "tool", status, input: JSON.stringify(item.arguments ?? {}) }]
  return []
}

function toolStatus(value: unknown): "done" | "error" {
  const item = record(value)
  return item?.status === "failed" || item?.status === "declined" || item?.success === false ? "error" : "done"
}
function textEvent(type: "text" | "thinking", value: unknown): AgentStreamEvent[] {
  const valueText = text(value)
  return valueText ? [{ type, text: valueText }] : []
}
function record(value: unknown): RecordValue | null { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null }
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined }
function number(value: unknown): number | undefined { return typeof value === "number" ? value : undefined }
