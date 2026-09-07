import type { ChatSlashCommand } from "@/components/ui/chat-input"
import type { DiscoveredCommand } from "@/lib/skills"

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

/**
 * The app's commands plus the ones discovered on this machine
 * (`GET /api/skills`), for the composer's `/` menu.
 *
 * A discovered command belongs to the harness, not to this app: it runs only
 * when it opens the message, because anywhere else the CLI reads it as
 * ordinary text and the agent answers the prose instead of running anything.
 * `mustStartMessage` is what tells the composer to stop offering it once the
 * `/` is no longer the first character.
 *
 * The app's own commands win a name collision — `/new` has to keep making a
 * chat — and nothing here is ever sent anywhere: `parseSlashCommand` claims
 * only the app's list, so a discovered `/compact` reaches the harness typed
 * exactly as the user typed it.
 */
export function slashCommandsWith(
  discovered: readonly DiscoveredCommand[]
): ChatSlashCommand[] {
  const taken = new Set(APP_SLASH_COMMANDS.map((command) => command.name))
  return [
    ...APP_SLASH_COMMANDS,
    ...discovered
      .filter((command) => !taken.has(command.name))
      .map<ChatSlashCommand>((command) => ({
        name: command.name,
        description:
          command.description ??
          (command.scope === "project" ? "Project command" : "Personal command"),
        ...(command.argHint ? { argHint: command.argHint } : {}),
        mustStartMessage: true,
      })),
  ]
}
