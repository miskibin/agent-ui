import {
  isPlanToolName,
  parsePlan,
  type PlanData,
} from "@/components/ui/plan-card"
import {
  isTodoToolName,
  parseTodoItems,
  type TodoItem,
} from "@/components/ui/todo-list"
import type { StoredMessage } from "@/lib/store/types"

/** One frozen array, so "no plan" never re-renders the panel. */
export const EMPTY_TODOS: TodoItem[] = []

/**
 * The newest plan in a thread, whoever wrote it — a `todo_write`-style tool
 * from the harness, or an ACP `plan` update that `lib/acp-agent.ts` folds into
 * the same tool arguments. Derived from the transcript rather than tracked
 * alongside it, so a reloaded chat shows the plan the live turn ended on.
 */
export function latestTodos(messages: StoredMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts
    if (!parts) continue
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (part.type !== "tool" || !isTodoToolName(part.tool.name)) continue
      const items = parseTodoItems(part.tool.input)
      if (items) return items
    }
  }
  return EMPTY_TODOS
}

/** A written plan, and where in the transcript it was written. */
export type ThreadPlan = {
  messageId: string
  toolId: string
  plan: PlanData
}

/**
 * The plan the chat is *on* — the newest one in the last turn, or null.
 *
 * Deliberately the last turn only, matching the rule `MessageList` follows for
 * offering Build: a plan three turns back is history, and a side panel holding
 * it open with a Build button would offer to implement something the
 * conversation has already moved past. When the newest turn wrote no plan
 * there is nothing to show, which is also how the panel closes itself.
 */
export function livePlan(messages: StoredMessage[]): ThreadPlan | null {
  const message = messages.at(-1)
  if (!message || message.sender !== "assistant") return null
  const parts = message.parts
  if (!parts) return null
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part.type !== "tool" || !isPlanToolName(part.tool.name)) continue
    const plan = parsePlan(part.tool.input)
    if (plan) return { messageId: message.id, toolId: part.tool.id, plan }
  }
  return null
}
