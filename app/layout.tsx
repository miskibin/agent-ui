import type { Metadata } from "next"
import "./globals.css"
import { Toaster } from "sonner"
import { DesktopUpdater } from "@/components/desktop-updater"
import { ThemeProvider } from "@/components/theme-provider"
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
      <body className="min-h-svh" suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AppearanceProvider>{children}</AppearanceProvider>
        </ThemeProvider>
        <Toaster position="top-right" richColors />
        {/* Renders nothing: schedules the desktop shell's update check for an
            idle moment after startup. A no-op in a browser tab. */}
        <DesktopUpdater />
      </body>
    </html>
  )
}
