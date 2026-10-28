/**
 * Hand-tuned themes.
 *
 * Modern Minimal and Claude stay verbatim registry items (`generated.ts`).
 * Everything else from that catalog failed in this app: stained body text,
 * a primary that reads as disabled, a handwriting face, letter-spacing on
 * every glyph, or a near-white rule on a dark sidebar. The themes here follow
 * the structure of the two that work — neutral-enough surfaces, one accent
 * that still reads as a control, quiet shadows, Inter — and each pair was
 * checked in light and dark at the standard contrast level so the repair
 * pass has nothing to move. Ink, Grove and Dusk stay quiet. Ember, Rose and
 * Iris push the primary harder; the page around it does not.
 */

import type { TweakcnTheme, TweakcnVars } from "./types"

const SANS = "Inter, sans-serif"
const MONO = "JetBrains Mono, monospace"
const SERIF = "Source Serif 4, serif"

const TRACKING: TweakcnVars = {
  "tracking-tighter": "calc(var(--tracking-normal) - 0.05em)",
  "tracking-tight": "calc(var(--tracking-normal) - 0.025em)",
  "tracking-wide": "calc(var(--tracking-normal) + 0.025em)",
  "tracking-wider": "calc(var(--tracking-normal) + 0.05em)",
  "tracking-widest": "calc(var(--tracking-normal) + 0.1em)",
}

/** The same quiet shadow the default theme uses. No offset, no coloured glow. */
const SHADOW: TweakcnVars = {
  "shadow-color": "oklch(0 0 0)",
  "shadow-opacity": "0.1",
  "shadow-blur": "3px",
  "shadow-spread": "0px",
  "shadow-offset-x": "0",
  "shadow-offset-y": "1px",
  "shadow-2xs": "0 1px 3px 0px hsl(0 0% 0% / 0.05)",
  "shadow-xs": "0 1px 3px 0px hsl(0 0% 0% / 0.05)",
  "shadow-sm":
    "0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 1px 2px -1px hsl(0 0% 0% / 0.10)",
  shadow:
    "0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 1px 2px -1px hsl(0 0% 0% / 0.10)",
  "shadow-md":
    "0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 2px 4px -1px hsl(0 0% 0% / 0.10)",
  "shadow-lg":
    "0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 4px 6px -1px hsl(0 0% 0% / 0.10)",
  "shadow-xl":
    "0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 8px 10px -1px hsl(0 0% 0% / 0.10)",
  "shadow-2xl": "0 1px 3px 0px hsl(0 0% 0% / 0.25)",
}

const RED = "oklch(0.6368 0.2078 25.3313)"
const WHITE = "oklch(1 0 0)"

function mode(radius: string, colors: TweakcnVars): TweakcnVars {
  return {
    ...colors,
    radius,
    "font-sans": SANS,
    "font-serif": SERIF,
    "font-mono": MONO,
    "letter-spacing": "0em",
    spacing: "0.25rem",
    "tracking-normal": "0em",
    ...SHADOW,
  }
}

function theme(
  id: string,
  name: string,
  description: string,
  radius: string,
  light: TweakcnVars,
  dark: TweakcnVars
): TweakcnTheme {
  return {
    id,
    name,
    description,
    cssVars: {
      theme: {
        "font-sans": SANS,
        "font-mono": MONO,
        "font-serif": SERIF,
        radius,
        ...TRACKING,
      },
      light: mode(radius, light),
      dark: mode(radius, dark),
    },
  }
}

/**
 * Achromatic on purpose. The primary is near-black in daylight and near-white
 * at night, so a button stays a filled control — a mid grey reads as disabled.
 * Body text sits a step away from that primary, or the links disappear.
 */
const ink = theme(
  "ink",
  "Ink",
  "Black and white, with the glare taken out.",
  "0.375rem",
  {
    background: "oklch(0.985 0 0)",
    foreground: "oklch(0.36 0 0)",
    card: "oklch(1 0 0)",
    "card-foreground": "oklch(0.36 0 0)",
    popover: "oklch(1 0 0)",
    "popover-foreground": "oklch(0.36 0 0)",
    primary: "oklch(0.21 0 0)",
    "primary-foreground": "oklch(0.985 0 0)",
    secondary: "oklch(0.955 0 0)",
    "secondary-foreground": "oklch(0.32 0 0)",
    muted: "oklch(0.955 0 0)",
    "muted-foreground": "oklch(0.48 0 0)",
    accent: "oklch(0.955 0 0)",
    "accent-foreground": "oklch(0.36 0 0)",
    destructive: RED,
    "destructive-foreground": WHITE,
    border: "oklch(0.86 0 0)",
    input: "oklch(0.86 0 0)",
    ring: "oklch(0.21 0 0)",
    "chart-1": "oklch(0.40 0 0)",
    "chart-2": "oklch(0.55 0 0)",
    "chart-3": "oklch(0.30 0 0)",
    "chart-4": "oklch(0.68 0 0)",
    "chart-5": "oklch(0.22 0 0)",
    sidebar: "oklch(0.962 0 0)",
    "sidebar-foreground": "oklch(0.36 0 0)",
    "sidebar-primary": "oklch(0.21 0 0)",
    "sidebar-primary-foreground": "oklch(0.985 0 0)",
    "sidebar-accent": "oklch(0.94 0 0)",
    "sidebar-accent-foreground": "oklch(0.36 0 0)",
    "sidebar-border": "oklch(0.86 0 0)",
    "sidebar-ring": "oklch(0.21 0 0)",
  },
  {
    background: "oklch(0.185 0 0)",
    foreground: "oklch(0.84 0 0)",
    card: "oklch(0.235 0 0)",
    "card-foreground": "oklch(0.84 0 0)",
    popover: "oklch(0.255 0 0)",
    "popover-foreground": "oklch(0.84 0 0)",
    primary: "oklch(0.97 0 0)",
    "primary-foreground": "oklch(0.18 0 0)",
    secondary: "oklch(0.27 0 0)",
    "secondary-foreground": "oklch(0.84 0 0)",
    muted: "oklch(0.25 0 0)",
    "muted-foreground": "oklch(0.70 0 0)",
    accent: "oklch(0.25 0 0)",
    "accent-foreground": "oklch(0.84 0 0)",
    destructive: RED,
    "destructive-foreground": WHITE,
    border: "oklch(0.33 0 0)",
    input: "oklch(0.36 0 0)",
    ring: "oklch(0.97 0 0)",
    "chart-1": "oklch(0.78 0 0)",
    "chart-2": "oklch(0.62 0 0)",
    "chart-3": "oklch(0.88 0 0)",
    "chart-4": "oklch(0.48 0 0)",
    "chart-5": "oklch(0.70 0 0)",
    sidebar: "oklch(0.155 0 0)",
    "sidebar-foreground": "oklch(0.84 0 0)",
    "sidebar-primary": "oklch(0.97 0 0)",
    "sidebar-primary-foreground": "oklch(0.18 0 0)",
    "sidebar-accent": "oklch(0.22 0 0)",
    "sidebar-accent-foreground": "oklch(0.84 0 0)",
    "sidebar-border": "oklch(0.32 0 0)",
    "sidebar-ring": "oklch(0.97 0 0)",
  }
)

/**
 * Paper with a whisper of warmth, and a forest accent dark enough for white
 * type in both modes. The green stays on the controls — body text is only
 * barely green, so a long transcript does not go seasick.
 */
const grove = theme(
  "grove",
  "Grove",
  "Forest green on warm paper.",
  "0.5rem",
  {
    background: "oklch(0.982 0.008 115)",
    foreground: "oklch(0.33 0.02 150)",
    card: "oklch(0.993 0.005 110)",
    "card-foreground": "oklch(0.33 0.02 150)",
    popover: "oklch(0.995 0.004 100)",
    "popover-foreground": "oklch(0.33 0.02 150)",
    primary: "oklch(0.50 0.11 158)",
    "primary-foreground": WHITE,
    secondary: "oklch(0.95 0.014 120)",
    "secondary-foreground": "oklch(0.38 0.03 150)",
    muted: "oklch(0.948 0.014 120)",
    "muted-foreground": "oklch(0.48 0.025 150)",
    accent: "oklch(0.948 0.014 120)",
    "accent-foreground": "oklch(0.33 0.02 150)",
    destructive: RED,
    "destructive-foreground": WHITE,
    border: "oklch(0.86 0.014 125)",
    input: "oklch(0.86 0.014 125)",
    ring: "oklch(0.50 0.11 158)",
    "chart-1": "oklch(0.55 0.11 158)",
    "chart-2": "oklch(0.45 0.09 165)",
    "chart-3": "oklch(0.65 0.10 145)",
    "chart-4": "oklch(0.40 0.07 150)",
    "chart-5": "oklch(0.70 0.08 130)",
    sidebar: "oklch(0.958 0.016 125)",
    "sidebar-foreground": "oklch(0.33 0.02 150)",
    "sidebar-primary": "oklch(0.50 0.11 158)",
    "sidebar-primary-foreground": WHITE,
    "sidebar-accent": "oklch(0.93 0.016 125)",
    "sidebar-accent-foreground": "oklch(0.33 0.02 150)",
    "sidebar-border": "oklch(0.85 0.016 125)",
    "sidebar-ring": "oklch(0.50 0.11 158)",
  },
  {
    background: "oklch(0.20 0.014 160)",
    foreground: "oklch(0.91 0.016 140)",
    card: "oklch(0.25 0.016 160)",
    "card-foreground": "oklch(0.91 0.016 140)",
    popover: "oklch(0.27 0.018 160)",
    "popover-foreground": "oklch(0.91 0.016 140)",
    primary: "oklch(0.58 0.12 158)",
    "primary-foreground": WHITE,
    secondary: "oklch(0.28 0.016 160)",
    "secondary-foreground": "oklch(0.91 0.016 140)",
    muted: "oklch(0.245 0.014 160)",
    "muted-foreground": "oklch(0.74 0.02 145)",
    accent: "oklch(0.26 0.014 160)",
    "accent-foreground": "oklch(0.91 0.016 140)",
    destructive: RED,
    "destructive-foreground": WHITE,
    border: "oklch(0.34 0.016 160)",
    input: "oklch(0.36 0.016 160)",
    ring: "oklch(0.58 0.12 158)",
    "chart-1": "oklch(0.70 0.12 158)",
    "chart-2": "oklch(0.60 0.10 165)",
    "chart-3": "oklch(0.78 0.09 145)",
    "chart-4": "oklch(0.50 0.08 155)",
    "chart-5": "oklch(0.82 0.07 130)",
    sidebar: "oklch(0.17 0.014 160)",
    "sidebar-foreground": "oklch(0.91 0.016 140)",
    "sidebar-primary": "oklch(0.58 0.12 158)",
    "sidebar-primary-foreground": WHITE,
    "sidebar-accent": "oklch(0.23 0.016 160)",
    "sidebar-accent-foreground": "oklch(0.91 0.016 140)",
    "sidebar-border": "oklch(0.30 0.016 160)",
    "sidebar-ring": "oklch(0.58 0.12 158)",
  }
)

/**
 * The same jewel in both modes, dustier than a neon purple. Surfaces carry
 * just enough of the hue to feel like one theme, not enough to tint the type.
 */
const dusk = theme(
  "dusk",
  "Dusk",
  "Quiet violet, in daylight and at night.",
  "0.5rem",
  {
    background: "oklch(0.982 0.008 290)",
    foreground: "oklch(0.32 0.022 285)",
    card: "oklch(0.993 0.004 290)",
    "card-foreground": "oklch(0.32 0.022 285)",
    popover: "oklch(0.995 0.004 290)",
    "popover-foreground": "oklch(0.32 0.022 285)",
    primary: "oklch(0.50 0.13 292)",
    "primary-foreground": WHITE,
    secondary: "oklch(0.95 0.014 290)",
    "secondary-foreground": "oklch(0.38 0.03 285)",
    muted: "oklch(0.948 0.014 290)",
    "muted-foreground": "oklch(0.48 0.028 285)",
    accent: "oklch(0.948 0.014 290)",
    "accent-foreground": "oklch(0.32 0.022 285)",
    destructive: RED,
    "destructive-foreground": WHITE,
    border: "oklch(0.86 0.014 290)",
    input: "oklch(0.86 0.014 290)",
    ring: "oklch(0.50 0.13 292)",
    "chart-1": "oklch(0.55 0.13 292)",
    "chart-2": "oklch(0.45 0.11 285)",
    "chart-3": "oklch(0.65 0.11 300)",
    "chart-4": "oklch(0.40 0.08 280)",
    "chart-5": "oklch(0.72 0.08 295)",
    sidebar: "oklch(0.955 0.016 292)",
    "sidebar-foreground": "oklch(0.32 0.022 285)",
    "sidebar-primary": "oklch(0.50 0.13 292)",
    "sidebar-primary-foreground": WHITE,
    "sidebar-accent": "oklch(0.93 0.016 292)",
    "sidebar-accent-foreground": "oklch(0.32 0.022 285)",
    "sidebar-border": "oklch(0.85 0.016 292)",
    "sidebar-ring": "oklch(0.50 0.13 292)",
  },
  {
    background: "oklch(0.19 0.02 285)",
    foreground: "oklch(0.91 0.016 290)",
    card: "oklch(0.24 0.024 285)",
    "card-foreground": "oklch(0.91 0.016 290)",
    popover: "oklch(0.26 0.026 285)",
    "popover-foreground": "oklch(0.91 0.016 290)",
    primary: "oklch(0.58 0.13 292)",
    "primary-foreground": WHITE,
    secondary: "oklch(0.27 0.022 285)",
    "secondary-foreground": "oklch(0.91 0.016 290)",
    muted: "oklch(0.235 0.02 285)",
    "muted-foreground": "oklch(0.74 0.022 290)",
    accent: "oklch(0.25 0.022 285)",
    "accent-foreground": "oklch(0.91 0.016 290)",
    destructive: RED,
    "destructive-foreground": WHITE,
    border: "oklch(0.34 0.024 285)",
    input: "oklch(0.36 0.024 285)",
    ring: "oklch(0.58 0.13 292)",
    "chart-1": "oklch(0.70 0.12 292)",
    "chart-2": "oklch(0.60 0.11 285)",
    "chart-3": "oklch(0.78 0.09 300)",
    "chart-4": "oklch(0.50 0.09 280)",
    "chart-5": "oklch(0.82 0.07 295)",
    sidebar: "oklch(0.16 0.02 285)",
    "sidebar-foreground": "oklch(0.91 0.016 290)",
    "sidebar-primary": "oklch(0.58 0.13 292)",
    "sidebar-primary-foreground": WHITE,
    "sidebar-accent": "oklch(0.22 0.022 285)",
    "sidebar-accent-foreground": "oklch(0.91 0.016 290)",
    "sidebar-border": "oklch(0.30 0.022 285)",
    "sidebar-ring": "oklch(0.58 0.13 292)",
  }
)

/**
 * A louder primary on the same quiet page. The hue tints the surfaces just
 * enough to belong to the button; chroma stays under the stain caps, and the
 * primary is the darkest saturated colour at that hue that still holds white
 * type (a hair above the 3.6:1 button bar, in both modes).
 */
function vivid(
  id: string,
  name: string,
  description: string,
  hue: number,
  lightPrimary: string,
  darkPrimary: string
): TweakcnTheme {
  const h = String(hue)
  return theme(
    id,
    name,
    description,
    "0.625rem",
    {
      background: `oklch(0.982 0.016 ${h})`,
      foreground: `oklch(0.32 0.024 ${h})`,
      card: `oklch(0.993 0.008 ${h})`,
      "card-foreground": `oklch(0.32 0.024 ${h})`,
      popover: `oklch(0.995 0.006 ${h})`,
      "popover-foreground": `oklch(0.32 0.024 ${h})`,
      primary: lightPrimary,
      "primary-foreground": WHITE,
      secondary: `oklch(0.95 0.018 ${h})`,
      "secondary-foreground": `oklch(0.36 0.03 ${h})`,
      muted: `oklch(0.948 0.016 ${h})`,
      "muted-foreground": `oklch(0.46 0.028 ${h})`,
      accent: `oklch(0.948 0.016 ${h})`,
      "accent-foreground": `oklch(0.32 0.024 ${h})`,
      destructive: RED,
      "destructive-foreground": WHITE,
      border: `oklch(0.84 0.02 ${h})`,
      input: `oklch(0.84 0.02 ${h})`,
      ring: lightPrimary,
      "chart-1": lightPrimary,
      "chart-2": `oklch(0.62 0.12 ${h})`,
      "chart-3": `oklch(0.4 0.1 ${h})`,
      "chart-4": `oklch(0.7 0.08 ${h})`,
      "chart-5": `oklch(0.5 0.06 ${h})`,
      sidebar: `oklch(0.955 0.02 ${h})`,
      "sidebar-foreground": `oklch(0.32 0.024 ${h})`,
      "sidebar-primary": lightPrimary,
      "sidebar-primary-foreground": WHITE,
      "sidebar-accent": `oklch(0.93 0.02 ${h})`,
      "sidebar-accent-foreground": `oklch(0.32 0.024 ${h})`,
      "sidebar-border": `oklch(0.83 0.02 ${h})`,
      "sidebar-ring": lightPrimary,
    },
    {
      background: `oklch(0.19 0.018 ${h})`,
      foreground: `oklch(0.91 0.02 ${h})`,
      card: `oklch(0.245 0.022 ${h})`,
      "card-foreground": `oklch(0.91 0.02 ${h})`,
      popover: `oklch(0.265 0.024 ${h})`,
      "popover-foreground": `oklch(0.91 0.02 ${h})`,
      primary: darkPrimary,
      "primary-foreground": WHITE,
      secondary: `oklch(0.28 0.02 ${h})`,
      "secondary-foreground": `oklch(0.91 0.02 ${h})`,
      muted: `oklch(0.24 0.018 ${h})`,
      "muted-foreground": `oklch(0.74 0.024 ${h})`,
      accent: `oklch(0.25 0.02 ${h})`,
      "accent-foreground": `oklch(0.91 0.02 ${h})`,
      destructive: RED,
      "destructive-foreground": WHITE,
      border: `oklch(0.36 0.028 ${h})`,
      input: `oklch(0.38 0.028 ${h})`,
      ring: darkPrimary,
      "chart-1": darkPrimary,
      "chart-2": `oklch(0.7 0.12 ${h})`,
      "chart-3": `oklch(0.5 0.1 ${h})`,
      "chart-4": `oklch(0.78 0.08 ${h})`,
      "chart-5": `oklch(0.42 0.08 ${h})`,
      sidebar: `oklch(0.16 0.02 ${h})`,
      "sidebar-foreground": `oklch(0.91 0.02 ${h})`,
      "sidebar-primary": darkPrimary,
      "sidebar-primary-foreground": WHITE,
      "sidebar-accent": `oklch(0.22 0.022 ${h})`,
      "sidebar-accent-foreground": `oklch(0.91 0.02 ${h})`,
      "sidebar-border": `oklch(0.32 0.024 ${h})`,
      "sidebar-ring": darkPrimary,
    }
  )
}

/**
 * Ayu's orange, taken down until white type holds. Darker and hotter than
 * Claude's clay, so the two warm themes don't read as the same button.
 */
const ember = vivid(
  "ember",
  "Ember",
  "Burnt orange, hotter than clay.",
  35,
  "oklch(0.46 0.161 35)",
  "oklch(0.58 0.203 35)"
)

/**
 * Rose Pine's "love" and Tokyo Night's red, on a page that stays paper.
 * Delete stays the brighter orange-red, so a rose button is not an error.
 */
const rose = vivid(
  "rose",
  "Rose",
  "A hot rose on quiet paper.",
  346,
  "oklch(0.47 0.199 346)",
  "oklch(0.58 0.22 346)"
)

/**
 * The loud indigo Dusk refuses to be. Dusk is a dusty violet; this one is a
 * jewel, and the transcript around it is still neutral.
 */
const iris = vivid(
  "iris",
  "Iris",
  "A jewel indigo, loud on purpose.",
  276,
  "oklch(0.48 0.24 276)",
  "oklch(0.58 0.231 276)"
)

export const AUTHORED_THEMES: TweakcnTheme[] = [ink, grove, dusk, ember, rose, iris]
