import type { Metadata } from "next"
import "./globals.css"
import { DesktopUpdater } from "@/components/desktop-updater"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import {
  APPEARANCE_BOOTSTRAP_SCRIPT,
  THEME_STYLE_ID,
  themePresetCss,
} from "@/lib/theme/apply"
import { AppearanceProvider } from "@/lib/theme/theme-client"
import { cn } from "@/lib/utils"

import { themeFontClassName } from "./fonts"

export const metadata: Metadata = {
  title: {
    default: "Agent UI",
    template: "%s — Agent UI",
  },
  description:
    "Local-first UI for coding agents: Cursor Agent, Claude Code, Ollama and more behind one provider interface.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      // Every theme font is mounted as a CSS variable; the active theme picks
      // which one --font-sans / --font-mono point at.
      className={cn("antialiased", themeFontClassName)}
    >
      <head>
        {/* Every theme preset, keyed by [data-theme] — see lib/theme/apply.ts. */}
        <style
          id={THEME_STYLE_ID}
          dangerouslySetInnerHTML={{ __html: themePresetCss() }}
        />
        {/* Stamps the stored preset + radius on <html> before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="h-full" suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AppearanceProvider>{children}</AppearanceProvider>
        </ThemeProvider>
        {/* Toasts wear the app's own theme, not sonner's stock palette: the
            vendored Toaster maps the neutral slots to the popover tokens, and
            these mix the rich-color slots out of --destructive / --primary so
            every preset (and dark mode) carries them. Spread order in that
            component means `style` replaces its own, so the normal slots are
            repeated here. */}
        <Toaster
          position="bottom-right"
          richColors
          style={
            {
              "--normal-bg": "var(--popover)",
              "--normal-text": "var(--popover-foreground)",
              "--normal-border": "var(--border)",
              "--error-bg":
                "color-mix(in oklab, var(--destructive) 12%, var(--popover))",
              "--error-text":
                "color-mix(in oklab, var(--destructive) 80%, var(--popover-foreground))",
              "--error-border":
                "color-mix(in oklab, var(--destructive) 35%, var(--border))",
              "--success-bg":
                "color-mix(in oklab, var(--primary) 12%, var(--popover))",
              "--success-text":
                "color-mix(in oklab, var(--primary) 80%, var(--popover-foreground))",
              "--success-border":
                "color-mix(in oklab, var(--primary) 35%, var(--border))",
              "--info-bg":
                "color-mix(in oklab, var(--accent) 60%, var(--popover))",
              "--info-text": "var(--accent-foreground)",
              "--info-border":
                "color-mix(in oklab, var(--accent) 50%, var(--border))",
              "--warning-bg":
                "color-mix(in oklab, var(--destructive) 8%, var(--popover))",
              "--warning-text":
                "color-mix(in oklab, var(--destructive) 60%, var(--popover-foreground))",
              "--warning-border":
                "color-mix(in oklab, var(--destructive) 22%, var(--border))",
            } as React.CSSProperties
          }
        />
        {/* Renders nothing: schedules the desktop shell's update check for an
            idle moment after startup. A no-op in a browser tab. */}
        <DesktopUpdater />
      </body>
    </html>
  )
}
