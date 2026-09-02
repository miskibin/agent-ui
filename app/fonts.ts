import {
  Architects_Daughter,
  DM_Sans,
  Fira_Code,
  Geist,
  Geist_Mono,
  IBM_Plex_Mono,
  Inter,
  JetBrains_Mono,
  Montserrat,
  Outfit,
  Source_Code_Pro,
  Space_Mono,
} from "next/font/google"

import type { ThemeFontFamily } from "@/lib/theme/fonts"

/**
 * Every web font the shipped themes name, loaded once and exposed as CSS
 * variables on <html>. Switching theme is then a variable swap — no font
 * request on the switch, no layout jump.
 *
 * `next/font` needs literal options, so the variable names are written out
 * here *and* in `lib/theme/fonts.ts`; the `Record<ThemeFontFamily, …>` below
 * makes a missing family a type error, and `scripts/import-tweakcn.mjs` warns
 * when a newly imported theme asks for a family nobody loads.
 *
 * `latin-ext` is not optional: the app ships with Polish copy in reach.
 */

const inter = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-inter",
  display: "swap",
})

const geist = Geist({
  subsets: ["latin", "latin-ext"],
  variable: "--font-geist",
  display: "swap",
})

const geistMono = Geist_Mono({
  subsets: ["latin", "latin-ext"],
  variable: "--font-geist-mono",
  display: "swap",
})

const outfit = Outfit({
  subsets: ["latin", "latin-ext"],
  variable: "--font-outfit",
  display: "swap",
})

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
})

const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
  display: "swap",
})

const montserrat = Montserrat({
  subsets: ["latin", "latin-ext"],
  variable: "--font-montserrat",
  display: "swap",
})

const dmSans = DM_Sans({
  subsets: ["latin", "latin-ext"],
  variable: "--font-dm-sans",
  display: "swap",
})

const architectsDaughter = Architects_Daughter({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-architects-daughter",
  display: "swap",
})

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin", "latin-ext"],
  variable: "--font-jetbrains-mono",
  display: "swap",
})

const firaCode = Fira_Code({
  subsets: ["latin", "latin-ext"],
  variable: "--font-fira-code",
  display: "swap",
})

const sourceCodePro = Source_Code_Pro({
  subsets: ["latin", "latin-ext"],
  variable: "--font-source-code-pro",
  display: "swap",
})

const THEME_FONTS: Record<ThemeFontFamily, { variable: string }> = {
  Inter: inter,
  Geist: geist,
  "Geist Mono": geistMono,
  Montserrat: montserrat,
  "DM Sans": dmSans,
  Outfit: outfit,
  "Architects Daughter": architectsDaughter,
  "JetBrains Mono": jetBrainsMono,
  "Fira Code": firaCode,
  "IBM Plex Mono": ibmPlexMono,
  "Space Mono": spaceMono,
  "Source Code Pro": sourceCodePro,
}

/** All font variables, for the <html> className. */
export const themeFontClassName = Object.values(THEME_FONTS)
  .map((font) => font.variable)
  .join(" ")
