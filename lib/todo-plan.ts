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
