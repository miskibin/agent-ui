"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import {
  AppHeader,
  AppHeaderActions,
  AppHeaderBrand,
  AppHeaderTitle,
} from "@/components/app-header"
import { ThemeToggle } from "@/components/ui/theme-toggle"
import { cn } from "@/lib/utils"

import { AppearanceSection } from "./appearance-section"
import { ChatSection } from "./chat-section"
import { DataSection } from "./data-section"
import { ProvidersSection } from "./providers-section"
import { useAppSettings } from "./use-app-settings"

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "providers", label: "Providers" },
  { id: "chat", label: "Chat" },
  { id: "data", label: "Data" },
]

/** Sticky rail on wide screens; the sections carry their own headings below xl. */
function SectionNav() {
  const [active, setActive] = React.useState(SECTIONS[0].id)

  React.useEffect(() => {
    const visible = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id)
          else visible.delete(entry.target.id)
        }
        const next = SECTIONS.find((section) => visible.has(section.id))
        if (next) setActive(next.id)
      },
      { rootMargin: "-8% 0px -62% 0px" }
    )
    for (const section of SECTIONS) {
      const node = document.getElementById(section.id)
      if (node) observer.observe(node)
    }
    return () => observer.disconnect()
  }, [])

  return (
    <nav aria-label="Settings sections" className="hidden xl:block">
      <ul className="sticky top-6 space-y-0.5">
        {SECTIONS.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              aria-current={active === section.id ? "true" : undefined}
              className={cn(
                "block rounded-md px-2.5 py-1.5 text-[12.5px] transition-colors outline-none",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                active === section.id
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function SettingsView({ dataDir }: { dataDir: string }) {
  const settings = useAppSettings()

  return (
    // Same shell as the chat page: the header is the desktop window chrome, so
    // it stays put and only the settings body scrolls.
    <div className="flex h-svh min-h-0 flex-col bg-background">
      <AppHeader>
        <AppHeaderBrand />
        <AppHeaderTitle title="Settings">
          <Link
            href="/"
            className="ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ArrowLeft className="size-3.5" />
            <span className="hidden sm:inline">Back to chat</span>
          </Link>
        </AppHeaderTitle>
        <AppHeaderActions>
          <ThemeToggle
            floating={false}
            className="size-8 rounded-md border-0 bg-transparent text-muted-foreground shadow-none hover:bg-muted hover:text-foreground"
          />
        </AppHeaderActions>
      </AppHeader>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-2xl grid-cols-1 gap-x-10 px-5 py-10 xl:max-w-5xl xl:grid-cols-[9rem_minmax(0,42rem)] xl:justify-center">
          <SectionNav />
          <div className="flex min-w-0 flex-col gap-8">
            <header>
              <h1 className="text-[19px] font-semibold tracking-tight text-foreground">
                Settings
              </h1>
              <p className="mt-1 text-[12.5px] break-words text-muted-foreground">
                Stored in {dataDir}/settings.json. Changes save as you make
                them.
              </p>
            </header>

            <AppearanceSection />
            <ProvidersSection {...settings} />
            <ChatSection {...settings} />
            <DataSection dataDir={dataDir} {...settings} />

            <p className="pb-6 text-[11px] text-muted-foreground">
              Agent UI runs entirely on this machine.
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
