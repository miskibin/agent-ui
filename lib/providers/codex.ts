import "server-only"

import type { ModelOption } from "@/components/ui/model-picker"
import { CodexClient } from "@/lib/codex-client"
import {
  sandboxFor,
  translateCodexNotification,
  usageFromNotification,
} from "@/lib/codex-protocol"
import { hasCodexBinary } from "@/lib/codex-runtime"
import { withPromptContext } from "@/lib/providers/system-prefix"
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  PermissionMode,
} from "@/lib/providers/types"
import type { CodexSettings } from "@/lib/settings/schema"
import { formatUserRequestInput, USER_REQUEST_WAITING } from "@/lib/turn-requests"

export const CODEX_PROVIDER_ID = "codex"
const MODES: PermissionMode[] = ["read-only", "edits", "full"]

/** Emits a completed agent message only when no delta for that item arrived. */
export function completedAgentMessageText(
  message: unknown,
  streamedItemIds: Set<string>,
): string | undefined {
  const envelope = message && typeof message === "object" && !Array.isArray(message)
    ? message as { method?: unknown; params?: unknown }
    : null
  if (envelope?.method !== "item/completed") return undefined
  const params = envelope.params && typeof envelope.params === "object" && !Array.isArray(envelope.params)
    ? envelope.params as { item?: unknown }
    : null
  const item = params?.item && typeof params.item === "object" && !Array.isArray(params.item)
    ? params.item as { type?: unknown; id?: unknown; text?: unknown }
    : null
  if (item?.type !== "agentMessage" || typeof item.id !== "string" || streamedItemIds.has(item.id)) return undefined
  return typeof item.text === "string" && item.text ? item.text : undefined
}

export function createCodexProvider(settings: CodexSettings): AgentProvider {
  const binPath = settings.binPath.trim()
  const workspace = settings.workspace.trim() || process.cwd()
  const detected = () => settings.enabled && hasCodexBinary(binPath)

  return {
    async info() {
      let signedOut = false
      if (detected()) {
        const client = CodexClient.spawn(binPath, workspace)
        try {
          await client.initialize()
          const account = await client.request("account/read", { refreshToken: false }) as { account?: unknown; requiresOpenaiAuth?: boolean }
          signedOut = account.requiresOpenaiAuth === true && account.account == null
        } catch {
          // A filesystem-detected CLI remains selectable; the run reports its
          // actionable startup error instead of a provider-list timeout hiding it.
        } finally { client.close() }
      }
      const available = detected() && !signedOut
      return {
        id: CODEX_PROVIDER_ID,
        name: "Codex",
        description: `OpenAI Codex app-server with tools in ${workspace}.`,
        capabilities: {
          tools: true,
          resume: true,
          effort: true,
          vision: false,
          permissionModes: MODES,
          defaultPermissionMode: settings.permissionMode,
        },
        available,
        ...(!available ? { unavailableReason: !settings.enabled ? "Disabled in settings" : signedOut ? "Codex is signed out" : binPath ? `No binary at ${binPath}` : "`codex` binary not found on PATH" } : null),
        configureBinary: process.platform === "win32" && settings.enabled && !hasCodexBinary(binPath),
      }
    },

    async listModels(): Promise<ModelOption[]> {
      if (!detected()) return []
      const client = CodexClient.spawn(binPath, workspace)
      try {
        await client.initialize()
        const models: ModelOption[] = []
        let cursor: string | null = null
        do {
          const page = await client.request("model/list", { cursor, includeHidden: false }) as { data?: Array<{ id?: string; model?: string; displayName?: string; description?: string }>; nextCursor?: string | null }
          for (const model of page.data ?? []) {
            const id = model.model || model.id
            if (id) models.push({ id, name: model.displayName || id, ...(model.description ? { description: model.description } : null) })
          }
          cursor = page.nextCursor ?? null
        } while (cursor)
        return models
      } finally { client.close() }
    },

    async *run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
      if (options.signal.aborted) return
      const cwd = options.cwd?.trim() || workspace
      const client = CodexClient.spawn(binPath, cwd)
      const startedAt = Date.now()
      let threadId = options.sessionId
      let turnId: string | undefined
      let usage: ReturnType<typeof usageFromNotification>
      const agentMessageDeltas = new Set<string>()
      const abort = () => {
        if (threadId && turnId) void client.request("turn/interrupt", { threadId, turnId }).catch(() => {})
        setTimeout(() => client.close(), 750).unref()
      }
      options.signal.addEventListener("abort", abort, { once: true })
      try {
        await client.initialize()
        if (options.signal.aborted) return
        const mode = options.permissionMode ?? settings.permissionMode
        const approvalPolicy = mode === "edits" ? "on-request" : "never"
        const threadParams = {
          model: options.model || null,
          cwd,
          approvalPolicy,
          approvalsReviewer: "user" as const,
          sandbox: sandboxFor(mode),
        }
        const response = await client.request(
          threadId ? "thread/resume" : "thread/start",
          threadId ? { threadId, ...threadParams } : threadParams
        ) as { thread?: { id?: string } }
        threadId = response.thread?.id
        if (!threadId) throw new Error("Codex did not return a thread id")
        if (options.signal.aborted) return
        yield { type: "session", sessionId: threadId }
        if (options.signal.aborted) return
        const turn = await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: withPromptContext(options.prompt, options), text_elements: [] }],
          model: options.model || null,
          effort: options.effort || null,
          cwd,
          approvalPolicy,
        }) as { turn?: { id?: string } }
        turnId = turn.turn?.id

        while (!options.signal.aborted) {
          const message = await client.next()
          if (!message) throw new Error("Codex app-server exited before completing the turn")
          if (message.id !== undefined && message.method) {
            if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
              yield* handleCodexApproval(message, options, client)
            } else {
              client.respondError(message.id, `Agent UI does not implement ${message.method}`)
            }
            continue
          }
          const nextUsage = usageFromNotification(message)
          if (nextUsage) usage = nextUsage
          if (message.method === "item/agentMessage/delta") {
            const params = message.params as { itemId?: unknown } | undefined
            if (typeof params?.itemId === "string") agentMessageDeltas.add(params.itemId)
          }
          yield* translateCodexNotification(message)
          const completedText = completedAgentMessageText(message, agentMessageDeltas)
          if (completedText) yield { type: "text", text: completedText }
          if (message.method === "turn/completed") {
            const params = message.params as { turn?: { status?: string; durationMs?: number } }
            if (params.turn?.status === "completed") yield { type: "done", sessionId: threadId, durationMs: params.turn.durationMs ?? Date.now() - startedAt, usage }
            return
          }
        }
      } catch (error) {
        if (!options.signal.aborted) yield { type: "error", message: error instanceof Error ? error.message : String(error) }
      } finally {
        options.signal.removeEventListener("abort", abort)
        client.close()
      }
    },
  }
}

export async function* handleCodexApproval(message: { id?: number | string; method?: string; params?: unknown }, options: AgentRunOptions, client: Pick<CodexClient, "respond">): AsyncGenerator<AgentStreamEvent> {
  if (message.id === undefined) return
  const params = message.params as Record<string, unknown> | undefined
  const targetId = typeof params?.itemId === "string" ? params.itemId : String(message.id)
  const itemId = `approval:${targetId}:${message.id}`
  const file = message.method === "item/fileChange/requestApproval"
  const request = {
    id: itemId,
    kind: "permission" as const,
    title: file ? "Allow file changes?" : "Allow command?",
    description: typeof params?.reason === "string" ? params.reason : undefined,
    options: [{ id: "accept", label: "Allow once", kind: "allow_once" }, { id: "decline", label: "Decline", kind: "reject_once" }],
    tool: { name: file ? "fileChange" : "command", input: file ? params?.grantRoot : params?.command },
  }
  yield { type: "tool", id: itemId, name: "permission", status: "running", input: formatUserRequestInput(request), output: USER_REQUEST_WAITING }
  const answer = options.askUser ? await options.askUser(request) : { cancelled: true }
  const available = Array.isArray(params?.availableDecisions) ? params.availableDecisions : undefined
  const wantsAccept = answer.optionId === "accept"
  const decision = wantsAccept && (!available || available.includes("accept")) ? "accept" : answer.cancelled ? "cancel" : "decline"
  client.respond(message.id, { decision })
  yield { type: "tool", id: itemId, name: "permission", status: decision === "accept" ? "done" : "error", output: decision }
}
