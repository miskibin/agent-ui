/**
 * Appearance application — the DOM half of the theme system.
 *
 * The stylesheet we own (`<style id="agent-ui-theme">`) carries *every* preset
 * at once, keyed by the `data-theme` attribute on <html>:
 *
 *   :root[data-theme="graphite"] { --background: … --radius: … --font-sans: … }
 *   .dark[data-theme="graphite"] { --background: … }
 *
 * Both selectors outrank the `:root` / `.dark` blocks in `app/globals.css`, and
 * the `.dark` half composes with next-themes, which owns the mode class. So
 * switching preset is a single attribute write — no stylesheet regeneration,
 * no per-variable `setProperty` loop — and the pre-paint guard below stays a
 * couple of hundred bytes because it never has to carry theme data.
 *
 * Every variable in the registry item is emitted as-is; the one edit is fonts,
 * where the loaded `var(--font-…)` is prepended to the theme's stack.
 */

import { DEFAULT_SETTINGS, type AppearanceSettings } from "@/lib/settings/schema"

import { withLoadedFont } from "./fonts"
import { THEME_PRESETS, findPreset, presetVars } from "./presets"

/** Id of the stylesheet rendered in <head> by `app/layout.tsx`. */
export const THEME_STYLE_ID = "agent-ui-theme"

/** localStorage mirror read by the pre-paint guard. */
export const APPEARANCE_STORAGE_KEY = "agent-ui:appearance"

/**
 * Sticky "this browser is the desktop shell" flag. Written by the header once
 * Tauri is detected and read by the same pre-paint guard, so the loading
 * skeleton can reserve the window-control strip instead of reflowing when the
 * client chunk hydrates.
 */
export const DESKTOP_STORAGE_KEY = "agent-ui:desktop"

/** Radius override bounds — the slider in Settings → Appearance. */
export const MIN_RADIUS = 0
export const MAX_RADIUS = 1.5

export function clampRadius(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, value))
}

/** `null` (the default) means "whatever radius the theme ships with". */
export function normalizeRadiusOverride(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? clampRadius(value)
    : null
}

const FONT_KEYS = new Set(["font-sans", "font-mono", "font-serif"])

function block(selector: string, vars: Record<string, string>) {
  let css = `${selector}{`
  for (const [key, value] of Object.entries(vars)) {
    css += `--${key}:${FONT_KEYS.has(key) ? withLoadedFont(value) : value};`
  }
  return `${css}}`
}

/** Every preset, serialized once. Stable output — safe to render server-side. */
export function themePresetCss(): string {
  let css = ""
  for (const preset of THEME_PRESETS) {
    css += block(`:root[data-theme="${preset.id}"]`, presetVars(preset, "light"))
    css += block(`.dark[data-theme="${preset.id}"]`, preset.cssVars.dark)
  }
  return css
}

/**
 * Pre-paint guard. Reads the localStorage mirrors and stamps the preset (plus
 * an optional radius override and the desktop flag) onto <html> before the
 * first paint, so a reload never flashes the default theme or a browser-shaped
 * header. Dependency-free, try/catch-wrapped, and mode-agnostic — next-themes'
 * own inline script still owns the `.dark` class.
 */
export const APPEARANCE_BOOTSTRAP_SCRIPT = `try{var d=document.documentElement,s=localStorage,v=JSON.parse(s.getItem(${JSON.stringify(
  APPEARANCE_STORAGE_KEY
)})||"{}");d.setAttribute("data-theme",typeof v.theme==="string"?v.theme:${JSON.stringify(
  DEFAULT_SETTINGS.appearance.theme
)});if(typeof v.radiusOverride==="number"&&v.radiusOverride>=${MIN_RADIUS}&&v.radiusOverride<=${MAX_RADIUS})d.style.setProperty("--radius",v.radiusOverride+"rem");if(s.getItem(${JSON.stringify(
  DESKTOP_STORAGE_KEY
)})==="1")d.setAttribute("data-desktop","1")}catch(e){}`

/**
 * Guarantees the preset stylesheet exists. It is server-rendered in <head>, so
 * this is a lookup on every path that matters; the injection branch only runs
 * if the document was built without it.
 */
function ensureStyleElement() {
  if (document.getElementById(THEME_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = THEME_STYLE_ID
  style.textContent = themePresetCss()
  document.head.appendChild(style)
}

/**
 * Applies preset + radius override to the document. Mode is *not* handled here
 * — that goes through next-themes' `setTheme` so the two never fight over the
 * class.
 */
export function applyAppearance(
  appearance: Pick<AppearanceSettings, "theme" | "radiusOverride">
) {
  if (typeof document === "undefined") return
  ensureStyleElement()
  const root = document.documentElement
  root.setAttribute("data-theme", findPreset(appearance.theme).id)
  const radius = normalizeRadiusOverride(appearance.radiusOverride)
  if (radius === null) root.style.removeProperty("--radius")
  else root.style.setProperty("--radius", `${radius}rem`)
}

export function readAppearanceMirror(): Partial<AppearanceSettings> | null {
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    return value && typeof value === "object"
      ? (value as Partial<AppearanceSettings>)
      : null
  } catch {
    return null
  }
}

export function writeAppearanceMirror(appearance: AppearanceSettings) {
  try {
    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify(appearance)
    )
  } catch {
    // Private mode / disabled storage: the guard just falls back to defaults.
  }
}

/** Remembers that this browser is the Tauri shell (see the guard above). */
export function rememberDesktopShell(desktop: boolean) {
  try {
    if (desktop) window.localStorage.setItem(DESKTOP_STORAGE_KEY, "1")
    else window.localStorage.removeItem(DESKTOP_STORAGE_KEY)
  } catch {
    // Nothing to reserve — the header still renders correctly after hydration.
  }
}
