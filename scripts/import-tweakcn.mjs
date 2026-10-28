#!/usr/bin/env node
/**
 * Regenerates `lib/theme/themes/generated.ts` from the tweakcn theme registry.
 *
 *   node scripts/import-tweakcn.mjs
 *
 * CURATED is only Modern Minimal and Claude. The rest of the tweakcn catalog
 * does not hold up in this app; the others are hand-tuned in
 * `lib/theme/themes/authored.ts` and must not be added back here.
 *
 * A registry item is stored verbatim (`cssVars.theme` / `.light` / `.dark`).
 * `lib/theme/apply.ts` emits every variable it finds; the only thing the app
 * knows about individual tokens is which font families it preloads
 * (`lib/theme/fonts.ts`), and this script warns when a curated theme asks for
 * a family that is not in that map.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "lib/theme/themes/generated.ts")
const REGISTRY = "https://tweakcn.com/r/themes"

/**
 * The registry pair. `id` is the item name and the value stored in
 * settings.json; `name` / `description` are what the settings page shows.
 * Anything else lives in `lib/theme/themes/authored.ts`, not in this list.
 */
const CURATED = [
  {
    id: "modern-minimal",
    name: "Modern Minimal",
    description: "Clean whites under a clear blue.",
  },
  {
    id: "claude",
    name: "Claude",
    description: "Warm clay on paper.",
  },
]

/** Families `app/fonts.ts` preloads — keep in step with lib/theme/fonts.ts. */
const KNOWN_FAMILIES = new Set([
  "Inter",
  "Geist",
  "Geist Mono",
  "Montserrat",
  "DM Sans",
  "Outfit",
  "Architects Daughter",
  "JetBrains Mono",
  "Fira Code",
  "IBM Plex Mono",
  "Space Mono",
  "Source Code Pro",
])

/** Generic families and system stacks never need loading. */
const SYSTEM_FAMILIES =
  /^(ui-|system-ui|-apple-system|BlinkMacSystemFont|Segoe UI|Menlo|Monaco|Consolas|Courier New|Georgia|Times|serif|sans-serif|monospace|Helvetica|Arial|Roboto|Noto|Apple Color Emoji)/i

function firstFamily(stack) {
  return (stack ?? "").split(",")[0].trim().replace(/^['"]|['"]$/g, "")
}

async function fetchTheme({ id, name, description }) {
  const url = `${REGISTRY}/${id}.json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  const item = await res.json()
  const vars = item.cssVars ?? {}
  for (const key of ["theme", "light", "dark"]) {
    if (!vars[key] || typeof vars[key] !== "object") {
      throw new Error(`${id}: cssVars.${key} missing`)
    }
  }
  for (const role of ["font-sans", "font-mono"]) {
    const family = firstFamily(vars.theme[role])
    if (family && !KNOWN_FAMILIES.has(family) && !SYSTEM_FAMILIES.test(family)) {
      console.warn(
        `  ! ${id}: ${role} "${family}" is not preloaded — add it to lib/theme/fonts.ts + app/fonts.ts`
      )
    }
  }
  return {
    id,
    name,
    description,
    cssVars: { theme: vars.theme, light: vars.light, dark: vars.dark },
  }
}

const themes = []
for (const entry of CURATED) {
  process.stdout.write(`→ ${entry.id}\n`)
  themes.push(await fetchTheme(entry))
}

const banner = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source: ${REGISTRY}/<id>.json (tweakcn's shadcn theme registry)
 * Regenerate: node scripts/import-tweakcn.mjs
 *
 * Only Modern Minimal and Claude are taken from the registry — they are the
 * two that hold up in this app. The others are hand-tuned in
 * ./authored.ts and must not be folded back into this file.
 *
 * Registry items are stored verbatim: \`cssVars.theme\` carries fonts, radius
 * and tracking, \`cssVars.light\` / \`cssVars.dark\` carry the full token set
 * (colors, sidebar, charts, shadows, spacing, letter-spacing).
 */

import type { TweakcnTheme } from "./types"

export const TWEAKCN_THEMES: TweakcnTheme[] = `

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, `${banner}${JSON.stringify(themes, null, 2)}\n`, "utf8")
console.log(`\nwrote ${themes.length} themes → ${OUT}`)
