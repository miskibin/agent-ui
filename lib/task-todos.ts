import type { TodoItem } from "@/components/ui/todo-list"
import type { StoredMessage } from "@/lib/store/types"

/** Claude's incremental task tools, replayed in transcript order. */
export function taskTodos(messages: StoredMessage[]): TodoItem[] | null {
  const tasks = new Map<string, TodoItem>()
  let seen = false
  for (const message of messages) {
    const tools = message.parts?.filter((part) => part.type === "tool").map((part) => part.tool) ?? message.tools ?? []
    for (const tool of tools) {
      if (!["TaskCreate", "TaskUpdate"].includes(tool.name) || tool.status === "error") continue
      let input: Record<string, unknown>
      try { input = JSON.parse(tool.input ?? "{}") } catch { continue }
      if (!input || typeof input !== "object") continue
      if (tool.name === "TaskCreate" && typeof input.subject === "string") {
        // Until the result assigns an id, the call itself identifies the row.
        let id = tool.id
        try {
          const result = JSON.parse(tool.output ?? "{}")
          const reported = result?.task?.id ?? result?.taskId ?? result?.id
          if (typeof reported === "string" || typeof reported === "number") id = String(reported)
        } catch {
          id = tool.output?.match(/Task\s+#(\d+)\s+created/i)?.[1] ?? id
        }
        tasks.set(id, { id, content: input.subject, status: "pending" })
        seen = true
      } else if (tool.name === "TaskUpdate" && typeof input.taskId === "string") {
        const task = tasks.get(input.taskId)
        if (!task) continue
        if (input.status === "deleted") tasks.delete(input.taskId)
        else tasks.set(input.taskId, {
          ...task,
          content: typeof input.subject === "string" ? input.subject : task.content,
          status: input.status === "completed" || input.status === "in_progress" || input.status === "pending" ? input.status : task.status,
        })
      }
    }
  }
  return seen ? [...tasks.values()] : null
}
