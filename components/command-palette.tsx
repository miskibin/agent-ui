"use client"

import {
  MessageSquare,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings as SettingsIcon,
  Sun,
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
import { adjustZoom } from "@/lib/theme/theme-client"
import { cn } from "@/lib/utils"

/**
 * ⌘K / Ctrl+K palette: jump between chats and run the handful of app-level
 * actions. Deliberately not a Radix dialog — a fixed overlay plus `cmdk` is
 * enough here, and it keeps the chat page's critical path free of another
 * portal library.
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
  /** Listed under the built-in actions, in order. */
  actions?: CommandPaletteAction[]
}

export function CommandPalette({
  open,
  onOpenChange,
  sessions,
  activeId,
  onSelectSession,
  onNewChat,
  onRenameSession,
  actions,
}: CommandPaletteProps) {
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  // Only the Tauri shell can install anything; the web build has no updater.
  const { desktop } = useDesktopChrome()

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

  const close = () => onOpenChange(false)
  const run = (action: () => void) => {
    close()
    action()
  }

  const isDark = resolvedTheme === "dark"

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
        <Command loop className="bg-transparent">
          <CommandInput autoFocus placeholder="Search chats and commands…" />
          <CommandList className="max-h-[min(24rem,60vh)]">
            <CommandEmpty className="text-muted-foreground">
              No matches.
            </CommandEmpty>

            {sessions?.length ? (
              <CommandGroup heading="Chats">
                {sessions.map((session) => (
                  <CommandItem
                    key={session.id}
                    value={`${session.title} ${session.meta ?? ""} ${session.id}`}
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

            {sessions?.length ? <CommandSeparator /> : null}

            <CommandGroup heading="Actions">
              {onNewChat ? (
                <CommandItem
                  value="New chat"
                  onSelect={() => run(() => onNewChat())}
                >
                  <Plus />
                  <span>New chat</span>
                  <CommandShortcut>⌘N</CommandShortcut>
                </CommandItem>
              ) : null}
              {activeId && onRenameSession ? (
                <CommandItem
                  value="Rename current chat"
                  onSelect={() => run(() => onRenameSession(activeId))}
                >
                  <Pencil />
                  <span>Rename current chat</span>
                </CommandItem>
              ) : null}
              {actions?.map((action) => (
                <CommandItem
                  key={action.id}
                  value={action.label}
                  onSelect={() => run(action.onSelect)}
                >
                  {action.icon}
                  <span>{action.label}</span>
                  {action.shortcut ? (
                    <CommandShortcut>{action.shortcut}</CommandShortcut>
                  ) : null}
                </CommandItem>
              ))}
              <CommandItem
                value="Open settings"
                onSelect={() => run(() => router.push("/settings"))}
              >
                <SettingsIcon />
                <span>Open settings</span>
              </CommandItem>
              <CommandItem
                value="Zoom in UI size"
                onSelect={() => run(() => adjustZoom(1))}
              >
                <ZoomIn />
                <span>Zoom in</span>
                <CommandShortcut>⌘+</CommandShortcut>
              </CommandItem>
              <CommandItem
                value="Zoom out UI size"
                onSelect={() => run(() => adjustZoom(-1))}
              >
                <ZoomOut />
                <span>Zoom out</span>
                <CommandShortcut>⌘−</CommandShortcut>
              </CommandItem>
              <CommandItem
                value="Reset zoom UI size"
                onSelect={() => run(() => adjustZoom(0))}
              >
                <RotateCcw />
                <span>Reset zoom</span>
                <CommandShortcut>⌘0</CommandShortcut>
              </CommandItem>
              <CommandItem
                value="Toggle theme dark light"
                onSelect={() => run(() => setTheme(isDark ? "light" : "dark"))}
              >
                {isDark ? <Sun /> : <Moon />}
                <span>Toggle theme</span>
                <CommandShortcut>
                  {isDark ? "Light" : "Dark"}
                </CommandShortcut>
              </CommandItem>
              {desktop ? (
                <CommandItem
                  value="Check for updates"
                  onSelect={() =>
                    run(() => void checkForUpdates({ manual: true }))
                  }
                >
                  <RefreshCw />
                  <span>Check for updates</span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    </div>
  )
}
