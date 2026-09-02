import type { ChatSlashCommand } from "@/components/ui/chat-input"

/**
 * The app's own `/` commands — things the composer can do without a model.
 * Anything not listed here is sent to the agent as typed, so a harness that
 * understands its own commands (`/compact`, `/review`) still gets them.
 */
export const APP_SLASH_COMMANDS: ChatSlashCommand[] = [
  { name: "clear", description: "Clear this chat and forget the agent's session" },
  { name: "new", description: "Start a new chat" },
  { name: "rename", description: "Rename this chat", argHint: "<title>" },
  { name: "title", description: "Let a model name this chat" },
  { name: "open", description: "Open the chat's folder in your editor" },
  { name: "reveal", description: "Show the chat's folder in the file manager" },
  { name: "terminal", description: "Open a terminal in the chat's folder" },
  { name: "settings", description: "Open settings" },
]

export type ParsedSlashCommand = { name: string; arg: string }

/** `/rename Fix the build` → `{ name: "rename", arg: "Fix the build" }`, or null. */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const match = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!match) return null
  const name = match[1].toLowerCase()
  if (!APP_SLASH_COMMANDS.some((command) => command.name === name)) return null
  return { name, arg: (match[2] ?? "").trim() }
}
