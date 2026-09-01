import {
  Architects_Daughter,
  DM_Sans,
  Fira_Code,
  Geist,
  Inter,
  JetBrains_Mono,
  Montserrat,
  Source_Code_Pro,
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
  Montserrat: montserrat,
  "DM Sans": dmSans,
  "Architects Daughter": architectsDaughter,
  "JetBrains Mono": jetBrainsMono,
  "Fira Code": firaCode,
  "Source Code Pro": sourceCodePro,
}

/** All font variables, for the <html> className. */
export const themeFontClassName = Object.values(THEME_FONTS)
  .map((font) => font.variable)
  .join(" ")
