/**
 * Appearance application — the DOM half of the theme system.
 *
 * The stylesheet we own (`<style id="agent-ui-theme">`) carries *every* preset
 * at once, keyed by the `data-theme` attribute on <html>:
 *
 *   :root[data-theme="ocean"] { --background: … }
 *   .dark[data-theme="ocean"] { --background: … }
 *
 * Both selectors outrank the `:root` / `.dark` blocks in `app/globals.css`, and
 * the `.dark` half composes with next-themes, which owns the mode class. So
 * switching preset is a single attribute write — no stylesheet regeneration,
 * no per-variable `setProperty` loop — and the pre-paint guard below stays a
 * couple of hundred bytes because it never has to carry color data.
 */

import { DEFAULT_SETTINGS, type AppearanceSettings } from "@/lib/settings/schema"

import { THEME_PRESETS, THEME_TOKENS, findPreset } from "./presets"

/** Id of the stylesheet rendered in <head> by `app/layout.tsx`. */
export const THEME_STYLE_ID = "agent-ui-theme"

/** localStorage mirror read by the pre-paint guard. */
export const APPEARANCE_STORAGE_KEY = "agent-ui:appearance"

export const MIN_RADIUS = 0
export const MAX_RADIUS = 1

export function clampRadius(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.appearance.radius
  return Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, value))
}

function block(selector: string, tokens: Record<string, string>) {
  let css = `${selector}{`
  for (const token of THEME_TOKENS) css += `--${token}:${tokens[token]};`
  return `${css}}`
}

/** Every preset, serialized once. Stable output — safe to render server-side. */
export function themePresetCss(): string {
  let css = ""
  for (const preset of THEME_PRESETS) {
    css += block(`:root[data-theme="${preset.id}"]`, preset.light)
    css += block(`.dark[data-theme="${preset.id}"]`, preset.dark)
  }
  return css
}

/**
 * Pre-paint guard. Reads the localStorage mirror and stamps the preset +
 * radius onto <html> before the first paint, so a reload never flashes the
 * default palette. Dependency-free, try/catch-wrapped, and mode-agnostic —
 * next-themes' own inline script still owns the `.dark` class.
 */
export const APPEARANCE_BOOTSTRAP_SCRIPT = `try{var d=document.documentElement,v=JSON.parse(localStorage.getItem(${JSON.stringify(
  APPEARANCE_STORAGE_KEY
)})||"{}");if(typeof v.theme==="string")d.setAttribute("data-theme",v.theme);if(typeof v.radius==="number"&&v.radius>=${MIN_RADIUS}&&v.radius<=${MAX_RADIUS})d.style.setProperty("--radius",v.radius+"rem")}catch(e){}`

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
 * Applies preset + radius to the document. Mode is *not* handled here — that
 * goes through next-themes' `setTheme` so the two never fight over the class.
 */
export function applyAppearance(
  appearance: Pick<AppearanceSettings, "theme" | "radius">
) {
  if (typeof document === "undefined") return
  ensureStyleElement()
  const root = document.documentElement
  root.setAttribute("data-theme", findPreset(appearance.theme).id)
  root.style.setProperty("--radius", `${clampRadius(appearance.radius)}rem`)
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
