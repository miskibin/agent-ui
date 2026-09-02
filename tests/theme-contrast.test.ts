import assert from "node:assert/strict"
import { test } from "node:test"

import { themePresetCss } from "@/lib/theme/apply"
import {
  CONTRAST_LEVELS,
  contrastRatio,
  contrastFixes,
  parseOklch,
  tunedVars,
  type ContrastLevel,
} from "@/lib/theme/contrast"
import { THEME_PRESETS } from "@/lib/theme/presets"
import type { TweakcnVars } from "@/lib/theme/themes/types"

/**
 * The pairs the app actually paints, and the ratio each has to clear. This is
 * the regression net for "white on white": every one of these failed in at
 * least one shipped theme before `lib/theme/contrast.ts` existed.
 *
 * `min` is the *standard* level's bar. `soft` is checked against a lower floor
 * and `high` against a higher one, from the same table.
 */
const CHECKS: { fg: string; bg: string; min: number }[] = [
  { fg: "foreground", bg: "background", min: 4.5 },
  { fg: "card-foreground", bg: "card", min: 4.5 },
  { fg: "popover-foreground", bg: "popover", min: 4.5 },
  { fg: "muted-foreground", bg: "background", min: 4.5 },
  { fg: "muted-foreground", bg: "muted", min: 4.5 },
  { fg: "accent-foreground", bg: "accent", min: 4.5 },
  { fg: "sidebar-foreground", bg: "sidebar", min: 4.5 },
  { fg: "sidebar-accent-foreground", bg: "sidebar-accent", min: 4.5 },
  { fg: "primary-foreground", bg: "primary", min: 3.6 },
  { fg: "destructive-foreground", bg: "destructive", min: 3.6 },
]

/**
 * The rows the components hand an accent surface without repainting the ink —
 * a chat row's title, a hovered artifact card. `foreground` on `accent` is the
 * pair that read 1.04:1 in `notebook` dark.
 */
const INHERITED: { fg: string; bg: string; min: number }[] = [
  { fg: "foreground", bg: "accent", min: 4.5 },
  { fg: "sidebar-foreground", bg: "sidebar-accent", min: 4.5 },
  { fg: "muted-foreground", bg: "accent", min: 3 },
  { fg: "muted-foreground", bg: "sidebar-accent", min: 3 },
]

/** Running text. */
const FLOOR: Record<ContrastLevel, number> = {
  soft: 3.5,
  standard: 4.5,
  high: 7,
}

/** Ink on a solid brand colour — large, bold, and a hue the theme picked. */
const SOLID_FLOOR: Record<ContrastLevel, number> = {
  soft: 3,
  standard: 3.6,
  high: 4.5,
}

function ratio(vars: TweakcnVars, fg: string, bg: string): number | null {
  const a = parseOklch(vars[fg])
  const b = parseOklch(vars[bg])
  return a && b ? contrastRatio(a, b) : null
}

function resolved(
  preset: (typeof THEME_PRESETS)[number],
  scheme: "light" | "dark",
  level: ContrastLevel
): TweakcnVars {
  const raw = { ...preset.cssVars.theme, ...preset.cssVars[scheme] }
  const base = tunedVars(raw, scheme)
  return { ...base, ...contrastFixes(base, level) }
}

for (const scheme of ["light", "dark"] as const) {
  for (const level of CONTRAST_LEVELS) {
    test(`every theme clears its ${level} bar in ${scheme}`, () => {
      for (const preset of THEME_PRESETS) {
        const vars = resolved(preset, scheme, level)
        for (const { fg, bg, min } of CHECKS) {
          const value = ratio(vars, fg, bg)
          if (value === null) continue
          // Body pairs move with the level; the solid-button pairs keep their
          // own, lower bar, so scale from the standard number rather than
          // asserting the level's floor on everything.
          const target = min >= 4.5 ? FLOOR[level] : SOLID_FLOOR[level]
          assert.ok(
            value >= target - 0.01,
            `${preset.id}/${scheme}/${level}: ${fg} on ${bg} is ${value.toFixed(2)}:1, wanted ${target}`
          )
        }
      }
    })
  }
}

test("text that inherits its colour onto an accent stays readable", () => {
  for (const preset of THEME_PRESETS) {
    for (const scheme of ["light", "dark"] as const) {
      const vars = resolved(preset, scheme, "standard")
      for (const { fg, bg, min } of INHERITED) {
        const value = ratio(vars, fg, bg)
        if (value === null) continue
        assert.ok(
          value >= min - 0.01,
          `${preset.id}/${scheme}: ${fg} on ${bg} is ${value.toFixed(2)}:1, wanted ${min}`
        )
      }
    }
  }
})

test("soft really is softer than high, and never below its floor", () => {
  for (const preset of THEME_PRESETS) {
    for (const scheme of ["light", "dark"] as const) {
      const soft = ratio(resolved(preset, scheme, "soft"), "muted-foreground", "background")
      const high = ratio(resolved(preset, scheme, "high"), "muted-foreground", "background")
      if (soft === null || high === null) continue
      assert.ok(
        high > soft,
        `${preset.id}/${scheme}: high (${high.toFixed(2)}) is not above soft (${soft.toFixed(2)})`
      )
    }
  }
})

test("the emitted stylesheet keeps the light half out of dark documents", () => {
  const css = themePresetCss()
  let guarded = 0

  for (const preset of THEME_PRESETS) {
    assert.ok(
      css.includes(`:root[data-theme="${preset.id}"]{`),
      `${preset.id}: no base block — a document with no contrast attribute would
       fall back to globals.css`
    )
    for (const level of CONTRAST_LEVELS) {
      // A level that moves nothing emits nothing, but whatever it does emit
      // has to carry the `:not(.dark)` guard: the extra attribute makes it more
      // specific than the *dark* base block, so an unguarded light rule would
      // repaint a dark window in light greys.
      assert.ok(
        !css.includes(`:root[data-theme="${preset.id}"][data-contrast="${level}"]`),
        `${preset.id}/${level}: unguarded light selector would win over the dark base`
      )
      if (
        css.includes(
          `:root:not(.dark)[data-theme="${preset.id}"][data-contrast="${level}"]`
        )
      ) {
        guarded++
      }
    }
  }

  // Not every theme needs every level, but "no light block anywhere" would
  // mean the guard above is passing because nothing is emitted at all.
  assert.ok(guarded > 0, "no guarded light contrast block was emitted")
})
