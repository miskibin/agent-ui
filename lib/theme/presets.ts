/**
 * Theme presets.
 *
 * Modern Minimal and Claude are registry items (`themes/generated.ts`) and
 * stay verbatim — they already look right. Ink, Grove and Dusk are
 * hand-tuned in `themes/authored.ts` for this app's surfaces. Adding another
 * means a new entry there, checked in both modes, not another tweakcn fetch.
 */

import { tunedVars } from "./contrast"
import { firstFontFamily } from "./fonts"
import { AUTHORED_THEMES } from "./themes/authored"
import { TWEAKCN_THEMES } from "./themes/generated"
import type { TweakcnTheme, TweakcnVars } from "./themes/types"

export type ThemePreset = TweakcnTheme
export type ThemeScheme = "light" | "dark"

export const THEME_PRESETS: ThemePreset[] = [
  ...TWEAKCN_THEMES,
  ...AUTHORED_THEMES,
]

export const DEFAULT_PRESET = THEME_PRESETS[0]

/**
 * Ids the old catalog stored in settings.json, pointed at the closest theme
 * that replaced them. Anything else unknown still falls back to the default.
 */
export const RETIRED_THEMES: Record<string, string> = {
  graphite: "ink",
  vercel: "ink",
  notebook: "ink",
  supabase: "grove",
  "ocean-breeze": "grove",
  perpetuity: "grove",
  "mocha-mousse": "claude",
  tangerine: "claude",
  "t3-chat": "claude",
  catppuccin: "dusk",
  "cosmic-night": "dusk",
  "amethyst-haze": "dusk",
  "bold-tech": "dusk",
}

/** Unknown / retired ids (older settings.json files) resolve to a live preset. */
export function findPreset(id: string | undefined): ThemePreset {
  const resolved = (id && RETIRED_THEMES[id]) || id
  return THEME_PRESETS.find((preset) => preset.id === resolved) ?? DEFAULT_PRESET
}

/**
 * The variables that apply to one mode: the mode-independent block first, then
 * the mode's own, then the accent the app derives from the theme's own primary
 * (`lib/theme/contrast.ts`). That last step is why this — not the raw registry
 * item — is what both `apply.ts` and the preset card read: a swatch that shows
 * the registry's accent would be showing a colour the app never paints.
 *
 * The per-level contrast repairs are *not* folded in here: they are emitted as
 * their own `[data-contrast]` block, so this stays the palette a document with
 * no contrast attribute gets.
 */
export function presetVars(
  preset: ThemePreset,
  scheme: ThemeScheme
): TweakcnVars {
  return tunedVars(
    { ...preset.cssVars.theme, ...preset.cssVars[scheme] },
    scheme
  )
}

/** Name of the UI typeface, for the preset card — "Inter", "Geist", … */
export function presetFontName(preset: ThemePreset): string {
  const stack = preset.cssVars.theme["font-sans"] ?? ""
  const family = firstFontFamily(stack)
  return family.startsWith("ui-") || family === "" ? "System" : family
}

/** The theme's own corner radius, e.g. `0.375rem`. */
export function presetRadius(preset: ThemePreset): string {
  return preset.cssVars.theme.radius ?? "0.5rem"
}
