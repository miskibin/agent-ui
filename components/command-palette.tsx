"use client"

import {
  Bot,
  MessageSquare,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings as SettingsIcon,
  Sun,
  UserRound,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import * as React from "react"

import { useDesktopChrome } from "@/components/app-header"
import { checkForUpdates } from "@/components/desktop-updater"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { useMessageSearch } from "@/app/hooks/use-command-palette"
import { nowMs, relativeTime } from "@/lib/chat-helpers"
import type { MessageSearchHit, MessageSearchRange } from "@/lib/message-search"
import {
  MATCH_TIER,
  insertRankedResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedResult,
} from "@/lib/search-ranking"
import { adjustZoom } from "@/lib/theme/theme-client"
import { cn } from "@/lib/utils"

/**
 * ⌘K / Ctrl+K palette: jump between chats — by name *or* by something said in
 * one — and run the handful of app-level actions. Deliberately not a Radix
 * dialog: a fixed overlay plus `cmdk` is enough here, and it keeps the chat
 * page's critical path free of another portal library.
 *
 * `cmdk`'s own filtering is off (`shouldFilter={false}`) and the matching is
 * `lib/search-ranking`'s, the same tiers the composer's `@` menu uses. Two
 * things need that. Titles rank the way every other picker in the app ranks —
 * an exact name, then a prefix, then a word, then anywhere — rather than by a
 * fuzzy score nobody can predict. And the groups keep the order they are
 * written in: message hits arrive already ranked by the server, and `cmdk`
 * would re-score them against the same query and shuffle both the rows and
 * the groups they sit in.
 */

export type CommandPaletteSession = {
  id: string
  title: string
  /** Subtitle line — provider · model, a timestamp, … */
  meta?: string
}

/** An app-level entry the page adds — open the folder, regenerate the title. */
export type CommandPaletteAction = {
  id: string
  label: string
  icon: React.ReactNode
  shortcut?: string
  onSelect: () => void
}

export type CommandPaletteProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions?: CommandPaletteSession[]
  /** Marks the current chat and enables "Rename current chat". */
  activeId?: string
  onSelectSession?: (id: string) => void
  onNewChat?: () => void
  /** Opens the sidebar's inline rename for `activeId`. */
  onRenameSession?: (id: string) => void
  /**
   * Opens a chat *at* one message — what selecting a Messages row should do.
   * Optional: without it a message hit opens its chat through
   * `onSelectSession`, which is the whole feature minus the scroll.
   */
  onOpenMessage?: (sessionId: string, messageId: string) => void
  /** Listed under the built-in actions, in order. */
  actions?: CommandPaletteAction[]
  /**
   * Opens settings. Given by a host that shows them as a panel over the chat;
   * without it the item navigates to `/settings`, which unmounts the chat and
   * with it any turn it is streaming.
   */
  onOpenSettings?: () => void
}

/** At most this many chats are listed once a query narrows them. */
const MAX_CHAT_RESULTS = 25

/**
 * A chat's subtitle can find it — "ollama" lists every chat that ran on one —
 * but it can never outrank a title, so its tiers sit a whole block above.
 */
const META_TIER_OFFSET = MATCH_TIER.fuzzy + MATCH_TIER.prefix

/** How well one label answers the query. Lower is better; null is no match. */
function labelScore(value: string, query: string) {
  return scoreQueryMatch({
    value: value.toLowerCase(),
    query,
    exactBase: MATCH_TIER.exact,
    prefixBase: MATCH_TIER.prefix,
    boundaryBase: MATCH_TIER.boundary,
    includesBase: MATCH_TIER.includes,
    fuzzyBase: MATCH_TIER.fuzzy,
  })
}

function rank<T>(
  items: T[],
  query: string,
  score: (item: T) => number | null,
  tieBreaker: (item: T) => string,
  limit: number
): T[] {
  if (!query) return items
  const ranked: RankedResult<T>[] = []
  for (const item of items) {
    const value = score(item)
    if (value === null) continue
    insertRankedResult(ranked, { item, score: value, tieBreaker: tieBreaker(item) }, limit)
  }
  return ranked.map((entry) => entry.item)
}

/** One row of the Actions group, before it is filtered. */
type PaletteEntry = {
  id: string
  label: string
  /** Extra words that should find it, never rendered. */
  keywords?: string
  icon: React.ReactNode
  shortcut?: React.ReactNode
  onSelect: () => void
}

/** The snippet, with the server's match offsets wrapped in `<mark>`. */
function Highlighted({
  text,
  ranges,
}: {
  text: string
  ranges: MessageSearchRange[]
}) {
  if (!ranges.length) return <>{text}</>
  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start))
    nodes.push(
      <mark
        key={range.start}
        className="bg-transparent font-medium text-foreground"
      >
        {text.slice(range.start, range.end)}
      </mark>
    )
    cursor = range.end
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return <>{nodes}</>
}

export function CommandPalette({ open, onOpenChange, ...rest }: CommandPaletteProps) {
  // One global listener: ⌘K/Ctrl+K toggles, Escape closes.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        onOpenChange(!open)
        return
      }
      if (open && event.key === "Escape") {
        event.preventDefault()
        onOpenChange(false)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, onOpenChange])

  // Hand focus back to whatever opened the palette when it closes.
  React.useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [open])

  if (!open) return null
  // Mounted only while open, so the query — and the search behind it — start
  // empty every time rather than needing to be reset on the way out.
  return <CommandPaletteOverlay onOpenChange={onOpenChange} {...rest} />
}

function CommandPaletteOverlay({
  onOpenChange,
  sessions,
  activeId,
  onSelectSession,
  onNewChat,
  onRenameSession,
  onOpenMessage,
  actions,
  onOpenSettings,
}: Omit<CommandPaletteProps, "open">) {
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  // Only the Tauri shell can install anything; the web build has no updater.
  const { desktop } = useDesktopChrome()
  const [query, setQuery] = React.useState("")
  // Frozen for as long as the palette is open: the row labels are "2h", not a
  // clock, and a re-read on every keystroke would only churn the rows.
  const [openedAt] = React.useState(nowMs)

  const normalized = normalizeSearchQuery(query)
  const search = useMessageSearch(query)

  const close = () => onOpenChange(false)
  const run = (action: () => void) => {
    close()
    action()
  }

  const isDark = resolvedTheme === "dark"

  const titleById = React.useMemo(
    () => new Map((sessions ?? []).map((session) => [session.id, session.title])),
    [sessions]
  )

  const chats = rank(
    sessions ?? [],
    normalized,
    (session) => {
      const title = labelScore(session.title || "Untitled", normalized)
      if (title !== null) return title
      const meta = session.meta ? labelScore(session.meta, normalized) : null
      return meta === null ? null : meta + META_TIER_OFFSET
    },
    (session) => session.title || session.id,
    MAX_CHAT_RESULTS
  )

  const entries: PaletteEntry[] = []
  if (onNewChat) {
    entries.push({
      id: "new-chat",
      label: "New chat",
      keywords: "create start",
      icon: <Plus />,
      shortcut: <CommandShortcut>⌘N</CommandShortcut>,
      onSelect: () => onNewChat(),
    })
  }
  if (activeId && onRenameSession) {
    entries.push({
      id: "rename",
      label: "Rename current chat",
      icon: <Pencil />,
      onSelect: () => onRenameSession(activeId),
    })
  }
  for (const action of actions ?? []) {
    entries.push({
      id: `action-${action.id}`,
      label: action.label,
      icon: action.icon,
      ...(action.shortcut
        ? { shortcut: <CommandShortcut>{action.shortcut}</CommandShortcut> }
        : null),
      onSelect: action.onSelect,
    })
  }
  entries.push(
    {
      id: "settings",
      label: "Open settings",
      keywords: "preferences configuration",
      icon: <SettingsIcon />,
      onSelect: () =>
        onOpenSettings ? onOpenSettings() : router.push("/settings"),
    },
    {
      id: "zoom-in",
      label: "Zoom in",
      keywords: "ui size larger",
      icon: <ZoomIn />,
      shortcut: <CommandShortcut>⌘+</CommandShortcut>,
      onSelect: () => adjustZoom(1),
    },
    {
      id: "zoom-out",
      label: "Zoom out",
      keywords: "ui size smaller",
      icon: <ZoomOut />,
      shortcut: <CommandShortcut>⌘−</CommandShortcut>,
      onSelect: () => adjustZoom(-1),
    },
    {
      id: "zoom-reset",
      label: "Reset zoom",
      keywords: "ui size",
      icon: <RotateCcw />,
      shortcut: <CommandShortcut>⌘0</CommandShortcut>,
      onSelect: () => adjustZoom(0),
    },
    {
      id: "theme",
      label: "Toggle theme",
      keywords: "dark light appearance",
      icon: isDark ? <Sun /> : <Moon />,
      shortcut: <CommandShortcut>{isDark ? "Light" : "Dark"}</CommandShortcut>,
      onSelect: () => setTheme(isDark ? "light" : "dark"),
    }
  )
  if (desktop) {
    entries.push({
      id: "updates",
      label: "Check for updates",
      keywords: "install version",
      icon: <RefreshCw />,
      onSelect: () => void checkForUpdates({ manual: true }),
    })
  }

  const visibleEntries = rank(
    entries,
    normalized,
    (entry) => {
      const label = labelScore(entry.label, normalized)
      if (label !== null) return label
      const keywords = entry.keywords
        ? labelScore(entry.keywords, normalized)
        : null
      return keywords === null ? null : keywords + META_TIER_OFFSET
    },
    (entry) => entry.label,
    entries.length
  )

  const showMessages = search.matches.length > 0 || search.pending

  return (
    <div
      data-slot="command-palette"
      className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]"
    >
      <div
        aria-hidden
        onClick={close}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px] duration-150 animate-in fade-in-0 motion-reduce:animate-none"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(event) => {
          // Pragmatic focus trap: the panel's only tab stop is the input.
          if (event.key === "Tab") event.preventDefault()
        }}
        className={cn(
          "relative w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-lg border bg-popover shadow-lg",
          "duration-150 animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none"
        )}
      >
        <Command loop shouldFilter={false} className="bg-transparent">
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search chats, messages and commands…"
          />
          <CommandList className="max-h-[min(24rem,60vh)]">
            <CommandEmpty className="text-muted-foreground">
              No matches.
            </CommandEmpty>

            {chats.length ? (
              <CommandGroup heading="Chats">
                {chats.map((session) => (
                  <CommandItem
                    key={session.id}
                    value={`chat-${session.id}`}
                    onSelect={() => run(() => onSelectSession?.(session.id))}
                  >
                    <MessageSquare />
                    <span className="min-w-0 flex-1 truncate">
                      {session.title || "Untitled"}
                    </span>
                    {session.meta ? (
                      <span className="max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground">
                        {session.meta}
                      </span>
                    ) : null}
                    {session.id === activeId ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        current
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            {showMessages ? (
              <>
                {chats.length ? <CommandSeparator /> : null}
                <CommandGroup heading="Messages">
                  {search.matches.map((hit) => (
                    <MessageRow
                      key={`${hit.sessionId}:${hit.messageId}`}
                      hit={hit}
                      title={titleById.get(hit.sessionId) || "Untitled"}
                      now={openedAt}
                      onSelect={() =>
                        run(() =>
                          onOpenMessage
                            ? onOpenMessage(hit.sessionId, hit.messageId)
                            : onSelectSession?.(hit.sessionId)
                        )
                      }
                    />
                  ))}
                  {search.pending && !search.matches.length ? (
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      Searching messages…
                    </div>
                  ) : null}
                  {search.hasMore ? (
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      More chats match — keep typing to narrow it down.
                    </div>
                  ) : null}
                </CommandGroup>
              </>
            ) : null}

            {chats.length || showMessages ? <CommandSeparator /> : null}

            {visibleEntries.length ? (
              <CommandGroup heading="Actions">
                {visibleEntries.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => run(entry.onSelect)}
                  >
                    {entry.icon}
                    <span>{entry.label}</span>
                    {entry.shortcut}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </div>
    </div>
  )
}

function MessageRow({
  hit,
  title,
  now,
  onSelect,
}: {
  hit: MessageSearchHit
  title: string
  now: number
  onSelect: () => void
}) {
  return (
    <CommandItem
      value={`message-${hit.sessionId}-${hit.messageId}`}
      onSelect={onSelect}
      className="items-start"
    >
      {hit.role === "user" ? <UserRound /> : <Bot />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {relativeTime(hit.updatedAt, now)}
          </span>
        </span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          <span className="mr-1">{hit.role === "user" ? "You:" : "Agent:"}</span>
          <Highlighted text={hit.snippet} ranges={hit.ranges} />
        </span>
      </span>
    </CommandItem>
  )
}
