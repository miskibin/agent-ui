"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArrowLeft,
  Bot,
  Boxes,
  Brain,
  Database,
  MessageSquare,
  SquareTerminal,
  Palette,
  Search,
  type LucideIcon,
} from "lucide-react"

import {
  AppHeader,
  AppHeaderActions,
} from "@/components/app-header"
import { Input } from "@/components/ui/input"
import { ThemeToggle } from "@/components/ui/theme-toggle"
import { cn } from "@/lib/utils"

import { AppearanceSection } from "./appearance-section"
import { ChatSection } from "./chat-section"
import { DataSection } from "./data-section"
import { EditorSection } from "./editor-section"
import { MemorySection } from "./memory-section"
import { ModelProvidersSection } from "./model-providers-section"
import { ProvidersSection } from "./providers-section"
import { useAppSettings } from "./use-app-settings"

export type SettingsSectionId =
  | "appearance"
  | "chat"
  | "providers"
  | "models"
  | "memory"
  | "editor"
  | "data"

type SettingsSection = {
  id: SettingsSectionId
  label: string
  icon: LucideIcon
  keywords: string
}

type SettingsGroup = {
  label: string
  sections: SettingsSection[]
}

const SECTION_GROUPS: SettingsGroup[] = [
  {
    label: "Preferences",
    sections: [
      {
        id: "appearance",
        label: "Appearance",
        icon: Palette,
        keywords: "theme color mode light dark font typeface radius",
      },
      {
        id: "chat",
        label: "Chat",
        icon: MessageSquare,
        keywords:
          "reasoning effort suggestions automatic titles conversation notification sounds audio chime desktop notifications badge handoff switching agents",
      },
    ],
  },
  {
    label: "Agents",
    sections: [
      {
        id: "providers",
        label: "Harnesses",
        icon: Bot,
        keywords:
          "default provider mock ollama pi cursor acp dsh agent model harness backend",
      },
      {
        id: "models",
        label: "Model providers",
        icon: Boxes,
        keywords: "models providers api key openai endpoint anthropic xai google deepseek groq mistral openrouter",
      },
      {
        id: "memory",
        label: "Memory",
        icon: Brain,
        keywords: "memory remember facts recall context notes learned",
      },
    ],
  },
  {
    label: "Application",
    sections: [
      {
        id: "editor",
        label: "Editor & terminal",
        icon: SquareTerminal,
        keywords:
          "editor vscode cursor zed windsurf jetbrains open in reveal finder explorer terminal shell",
      },
      {
        id: "data",
        label: "Data",
        icon: Database,
        keywords: "directory local files storage clear delete chats privacy",
      },
    ],
  },

]

const SECTIONS = SECTION_GROUPS.flatMap((group) => group.sections)
const SECTION_IDS = new Set<SettingsSectionId>(SECTIONS.map((section) => section.id))

const SIDEBAR_BACK =
  "inline-flex h-8 items-center gap-2 rounded-md px-2 text-[12.5px] text-sidebar-foreground/65 outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50"

const BACK_TO_CHAT =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"

function readSectionHash(): SettingsSectionId {
  if (typeof window === "undefined") return "appearance"
  const value = window.location.hash.slice(1) as SettingsSectionId
  return SECTION_IDS.has(value) ? value : "appearance"
}

function SectionLink({
  section,
  active,
  onSelect,
}: {
  section: SettingsSection
  active: boolean
  onSelect: (section: SettingsSectionId) => void
}) {
  const Icon = section.icon

  return (
    <a
      href={`#${section.id}`}
      data-slot="settings-nav-item"
      data-active={active}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(section.id)}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[12.5px] outline-none transition-colors",
        "focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span>{section.label}</span>
    </a>
  )
}

function SettingsSidebar({
  active,
  onSelect,
  onClose,
}: {
  active: SettingsSectionId
  onSelect: (section: SettingsSectionId) => void
  onClose?: () => void
}) {
  const [query, setQuery] = React.useState("")
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleGroups = SECTION_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((section) =>
      `${section.label} ${section.keywords}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    ),
  })).filter((group) => group.sections.length > 0)
  const selectSection = React.useCallback(
    (section: SettingsSectionId) => {
      setQuery("")
      onSelect(section)
    },
    [onSelect]
  )

  return (
    <aside
      data-slot="settings-sidebar"
      className="hidden w-[236px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className={cn(SIDEBAR_BACK, "cursor-pointer")}
          >
            <ArrowLeft className="size-3.5" />
            Back to chat
          </button>
        ) : (
          <Link href="/" className={SIDEBAR_BACK}>
            <ArrowLeft className="size-3.5" />
            Back to chat
          </Link>
        )}

        <div data-slot="settings-search" className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-sidebar-foreground/45" />
          <Input
            type="search"
            aria-label="Search settings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings"
            className="h-8 border-sidebar-border bg-background/45 pl-8 text-[12px] shadow-none placeholder:text-sidebar-foreground/45 focus-visible:ring-sidebar-ring/50"
          />
        </div>

        <nav aria-label="Settings sections" className="flex flex-col gap-4">
          {visibleGroups.map((group) => (
            <div key={group.label}>
              <p className="mb-1 px-2.5 text-[11px] font-medium text-sidebar-foreground/45">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.sections.map((section) => (
                  <li key={section.id}>
                    <SectionLink
                      section={section}
                      active={active === section.id}
                      onSelect={selectSection}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {visibleGroups.length === 0 ? (
            <p className="px-2.5 py-2 text-[12px] leading-relaxed text-sidebar-foreground/50">
              No settings match “{query.trim()}”.
            </p>
          ) : null}
        </nav>
      </div>

      <div
        data-slot="settings-sidebar-footer"
        className="border-t border-sidebar-border px-5 py-3 text-[11px] text-sidebar-foreground/45"
      >
        Settings save automatically
      </div>
    </aside>
  )
}

function MobileSectionNav({
  active,
  onSelect,
}: {
  active: SettingsSectionId
  onSelect: (section: SettingsSectionId) => void
}) {
  return (
    <nav
      data-slot="settings-mobile-nav"
      aria-label="Settings sections"
      className="sticky top-0 z-10 border-b bg-background/95 px-3 py-2 backdrop-blur-sm md:hidden"
    >
      <ul className="flex gap-1 overflow-x-auto">
        {SECTIONS.map((section) => {
          const Icon = section.icon
          const isActive = active === section.id
          return (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                data-slot="settings-mobile-nav-item"
                data-active={isActive}
                aria-current={isActive ? "page" : undefined}
                onClick={() => onSelect(section.id)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12px] outline-none transition-colors",
                  "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  isActive
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="size-3.5" />
                {section.label}
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * `onClose` is what tells this it is a panel over the chat rather than the
 * `/settings` route: the section comes from the caller instead of the hash,
 * and "Back to chat" closes the panel at every width instead of navigating —
 * a navigation would unmount the chat, and with it the turn it is streaming.
 */
export function SettingsView({
  dataDir,
  section,
  onClose,
}: {
  dataDir: string
  section?: SettingsSectionId
  onClose?: () => void
}) {
  const [active, setActive] = React.useState<SettingsSectionId>(
    section ?? "appearance"
  )
  const settings = useAppSettings()

  React.useEffect(() => {
    if (onClose) return
    const syncFromHash = () => setActive(readSectionHash())
    window.addEventListener("hashchange", syncFromHash)
    window.addEventListener("popstate", syncFromHash)
    queueMicrotask(syncFromHash)
    return () => {
      window.removeEventListener("hashchange", syncFromHash)
      window.removeEventListener("popstate", syncFromHash)
    }
  }, [onClose])

  React.useEffect(() => {
    if (!onClose) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const selectSection = React.useCallback((section: SettingsSectionId) => {
    setActive(section)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <AppHeader>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            /* The panel's own sidebar carries the desktop one, same as the
               route does. */
            className={cn(BACK_TO_CHAT, "cursor-pointer md:hidden")}
          >
            <ArrowLeft className="size-3.5" />
            <span className="hidden sm:inline">Back to chat</span>
          </button>
        ) : (
          <Link href="/" className={cn(BACK_TO_CHAT, "md:hidden")}>
            <ArrowLeft className="size-3.5" />
            <span className="hidden sm:inline">Back to chat</span>
          </Link>
        )}
        <AppHeaderActions>
          <ThemeToggle
            floating={false}
            className="size-8 rounded-md border-0 bg-transparent text-muted-foreground shadow-none hover:bg-muted hover:text-foreground"
          />
        </AppHeaderActions>
      </AppHeader>

      <div className="flex min-h-0 flex-1">
        <SettingsSidebar
          active={active}
          onSelect={selectSection}
          onClose={onClose}
        />

        <main data-slot="settings-content" className="min-w-0 flex-1 overflow-y-auto">
          <MobileSectionNav active={active} onSelect={selectSection} />
          <div className="mx-auto w-full max-w-[760px] px-5 py-9 sm:px-8 md:px-10 md:py-14 lg:py-16">
            {active === "appearance" ? <AppearanceSection /> : null}
            {active === "providers" ? (
              <ProvidersSection {...settings} />
            ) : null}
            {active === "models" ? (
              <ModelProvidersSection {...settings} />
            ) : null}
            {active === "chat" ? <ChatSection {...settings} /> : null}
            {active === "memory" ? <MemorySection {...settings} /> : null}
            {active === "editor" ? <EditorSection {...settings} /> : null}
            {active === "data" ? (
              <DataSection dataDir={dataDir} {...settings} />
            ) : null}


            <p className="mt-6 px-0.5 pb-4 text-[11px] text-muted-foreground">
              Agent UI runs entirely on this machine.
            </p>
          </div>
        </main>
      </div>
    </div>
  )
}
