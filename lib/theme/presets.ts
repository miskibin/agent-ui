/**
 * Theme presets — thin accessors over the vendored tweakcn registry items in
 * `lib/theme/themes/generated.ts`.
 *
 * There is deliberately no hand-written palette here any more: a preset *is*
 * its registry item, and everything the app shows (colors, radius, fonts,
 * shadows, tracking) comes from that item's `cssVars`. Adding a theme is one
 * entry in `scripts/import-tweakcn.mjs` plus a rerun.
 */

import { firstFontFamily } from "./fonts"
import { TWEAKCN_THEMES } from "./themes/generated"
import type { TweakcnTheme, TweakcnVars } from "./themes/types"

export type ThemePreset = TweakcnTheme
export type ThemeScheme = "light" | "dark"

export const THEME_PRESETS: ThemePreset[] = TWEAKCN_THEMES

export const DEFAULT_PRESET = THEME_PRESETS[0]

/** Unknown / retired ids (older settings.json files) fall back to the default. */
export function findPreset(id: string | undefined): ThemePreset {
  return THEME_PRESETS.find((preset) => preset.id === id) ?? DEFAULT_PRESET
}

/**
 * The variables that apply to one mode: the mode-independent block first, then
 * the mode's own, which is exactly the order `apply.ts` emits them in.
 */
export function presetVars(
  preset: ThemePreset,
  scheme: ThemeScheme
): TweakcnVars {
  return { ...preset.cssVars.theme, ...preset.cssVars[scheme] }
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
