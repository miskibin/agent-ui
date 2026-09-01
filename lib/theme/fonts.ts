/**
 * Web fonts the shipped themes ask for.
 *
 * tweakcn themes carry plain CSS font stacks (`"Inter, sans-serif"`). A stack
 * only renders as designed if the family is actually loaded, so every family
 * the curated set names is mapped here to the CSS variable `app/fonts.ts`
 * defines with `next/font/google`, and `lib/theme/apply.ts` prepends
 * `var(--font-…)` to the theme's own stack. Families that are not in this map
 * (system stacks like Menlo or Georgia) fall through untouched.
 *
 * This module is deliberately data-only — it is imported by client code, while
 * the `next/font` loaders live in `app/fonts.ts` and reach only the layout.
 */

export const THEME_FONT_VARS = {
  Inter: "--font-inter",
  Geist: "--font-geist",
  Montserrat: "--font-montserrat",
  "DM Sans": "--font-dm-sans",
  "Architects Daughter": "--font-architects-daughter",
  "JetBrains Mono": "--font-jetbrains-mono",
  "Fira Code": "--font-fira-code",
  "Source Code Pro": "--font-source-code-pro",
} as const satisfies Record<string, string>

export type ThemeFontFamily = keyof typeof THEME_FONT_VARS

/** First family of a CSS font stack, unquoted — `"Fira Code", monospace` → `Fira Code`. */
export function firstFontFamily(stack: string): string {
  return (stack.split(",")[0] ?? "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
}

/**
 * The stack a theme should actually use: the loaded family first (when we ship
 * it), then the theme's own stack as the fallback chain.
 */
export function withLoadedFont(stack: string): string {
  const family = firstFontFamily(stack)
  const variable = (THEME_FONT_VARS as Record<string, string>)[family]
  return variable ? `var(${variable}), ${stack}` : stack
}
