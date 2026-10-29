import { sniffImageMimeType } from "@/lib/attachments"
import type { AgentStreamEvent, PermissionMode } from "@/lib/providers/types"
import {
  type AskUser, type UserRequest, type UserRequestAnswer,
  formatUserRequestInput, USER_REQUEST_WAITING, userRequestToolName,
} from "@/lib/turn-requests"

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

/** Interactive asks are answered by the control request, never by replaying a new turn. */
export function interactiveClaudeEvent(event: AgentStreamEvent): AgentStreamEvent {
  return event.type === "tool" && event.name === "AskUserQuestion"
    ? { ...event, name: "question" } : event
}

/** The CLI's streaming input carries images and keeps the permission channel open. */
export function claudeUserMessage(prompt: string, images: string[] = []) {
  return {
    type: "user", session_id: "", parent_tool_use_id: null,
    message: { role: "user", content: [
      ...images.map((data) => ({ type: "image", source: {
        type: "base64", media_type: sniffImageMimeType(data), data,
      } })),
      { type: "text", text: prompt },
    ] },
  }
}

type ControlOptions = {
  send(value: unknown): void
  emit(event: AgentStreamEvent): void
  askUser?: AskUser
  permissionMode: PermissionMode
}

/** Claude-specific wire adapter; the application still sees ordinary UserRequests. */
export class ClaudeCodeControl {
  private pending = new Map<string, AbortController>()
  private tasks = new Set<Promise<void>>()
  private closed = false
  private options: ControlOptions

  constructor(options: ControlOptions) { this.options = options }

  handle(value: unknown): boolean {
    const frame = record(value)
    if (frame.type === "control_cancel_request") {
      const id = String(frame.request_id)
      this.pending.get(id)?.abort()
      return true
    }
    if (frame.type !== "control_request") return false
    const id = frame.request_id
    if (typeof id !== "string" || this.closed) return true
    if (this.pending.has(id)) return true
    const request = record(frame.request)
    if (request.subtype !== "can_use_tool") {
      this.options.send({ type: "control_response", response: {
        subtype: "error", request_id: id,
        error: `Unsupported control request: ${String(request.subtype)}`,
      } })
      return true
    }
    const abort = new AbortController()
    this.pending.set(id, abort)
    const task = this.answer(id, request, abort).finally(() => {
      this.pending.delete(id)
      this.tasks.delete(task)
    })
    this.tasks.add(task)
    return true
  }

  async close() {
    this.closed = true
    for (const abort of this.pending.values()) abort.abort()
    this.pending.clear()
    await Promise.allSettled(this.tasks)
  }

  private async answer(id: string, request: Record<string, unknown>, abort: AbortController) {
    const tool = typeof request.tool_name === "string" ? request.tool_name : "Unknown tool"
    const input = record(request.input)
    const rowId = `claude-request:${id}`
    const emit = (question: UserRequest, status: "running" | "done" | "error", output: string) => {
      this.options.emit({ type: "tool", id: question.id, name: userRequestToolName(question.kind),
        status, input: formatUserRequestInput(question), output })
    }
    const ask = async (question: UserRequest): Promise<UserRequestAnswer> => {
      // Register before emitting so a fast response always has a live waiter.
      const answer = this.options.askUser?.(question, { signal: abort.signal })
      emit(question, "running", USER_REQUEST_WAITING)
      const value: UserRequestAnswer = await Promise.race([
        answer ?? Promise.resolve<UserRequestAnswer>({ cancelled: true }),
        new Promise<UserRequestAnswer>((resolve) => {
          if (abort.signal.aborted) resolve({ cancelled: true })
          else abort.signal.addEventListener("abort", () => resolve({ cancelled: true }), { once: true })
        }),
      ])
      emit(question, value.cancelled ? "error" : "done",
        value.cancelled ? "Cancelled" : value.text ?? value.optionId ?? "Answered")
      return value
    }
    let response: Record<string, unknown> = { behavior: "deny", message: "User declined this action" }
    try {
      if (tool === "AskUserQuestion") {
        const questions = Array.isArray(input.questions) ? input.questions : []
        const answers: Record<string, string> = {}
        let complete = questions.length > 0
        for (const [index, raw] of questions.entries()) {
          if (abort.signal.aborted) { complete = false; break }
          const question = record(raw)
          if (typeof question.question !== "string") { complete = false; break }
          const options = (Array.isArray(question.options) ? question.options : []).flatMap((raw, index) => {
            const option = record(raw)
            return typeof option.label === "string" ? [{ id: String(index), label: option.label,
              ...(typeof option.description === "string" ? { description: option.description } : {}) }] : []
          })
          const multiple = question.multiSelect === true
          const value = await ask({ id: `${rowId}:${index}`, kind: !options.length ? "input" : "select",
            title: question.question, options, allowMultiple: multiple, allowCustom: true,
            tool: { name: tool, input: raw } })
          const ids = value.optionIds ?? (value.optionId ? [value.optionId] : [])
          const text = value.text?.trim() || options.filter((option) => ids.includes(option.id)).map((option) => option.label).join(", ")
          if (value.cancelled || !text) { complete = false; break }
          answers[question.question] = text
        }
        if (complete) response = { behavior: "allow", updatedInput: { ...input, answers } }
      } else if (this.options.permissionMode === "plan" || this.options.permissionMode === "read-only") {
        response = { behavior: "deny", message: "The chat's permission mode does not allow approving this action. The user must change the chat's mode before implementation." }
      } else {
        const value = await ask({ id: rowId, kind: "permission", title: `Allow ${tool}?`,
          description: typeof request.decision_reason === "string" ? request.decision_reason : undefined,
          options: [{ id: "allow", label: "Allow once", kind: "allow_once" },
            { id: "deny", label: "Decline", kind: "reject_once" }], tool: { name: tool, input } })
        if (!value.cancelled && value.optionId === "allow") response = { behavior: "allow", updatedInput: input }
        else if (value.text) response.message = value.text
      }
    } catch {
      response = { behavior: "deny", message: "The user interaction could not be completed" }
    }
    const cancelled = abort.signal.aborted
    abort.abort()
    if (!this.closed && !cancelled) {
      this.options.send({ type: "control_response", response: { subtype: "success", request_id: id, response } })
    }
  }
}
