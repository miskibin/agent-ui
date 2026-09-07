import assert from "node:assert/strict"
import { test } from "node:test"

import {
  modeLrgb,
  modeOklch,
  modeRgb,
  useMode as registerMode,
  wcagContrast,
} from "culori/fn"

import {
  CONTRAST_LEVELS,
  contrastFixes,
  contrastRatio,
  formatOklch,
  parseOklch,
  toSrgbGamut,
  tunedVars,
  type Oklch,
} from "@/lib/theme/contrast"
import { THEME_PRESETS } from "@/lib/theme/presets"

/**
 * The colour arithmetic under `lib/theme/contrast.ts`, checked against a
 * second opinion rather than against itself: `culori`'s own converters and its
 * own WCAG implementation. `tests/theme-contrast.test.ts` asserts the *result*
 * (every shipped theme clears its bar); this file asserts the machinery — that
 * a ratio is measured against a colour a display can show, that every CSS
 * notation reaches the repair path, and that a repair is the smallest one that
 * works.
 */

registerMode(modeLrgb)
const toRgb = registerMode(modeRgb)
const toOklch = registerMode(modeOklch)

/** culori's unclamped sRGB, so "in gamut" is not this module's own opinion. */
function srgbChannels({ l, c, h }: Oklch): number[] {
  const rgb = toRgb({ mode: "oklch", l, c, h })
  return [rgb.r, rgb.g, rgb.b]
}

const WHITE: Oklch = { l: 1, c: 0, h: 0 }
const BLACK: Oklch = { l: 0, c: 0, h: 0 }

test("an out-of-gamut oklch is mapped by chroma, at the same lightness and hue", () => {
  const wanted: Oklch = { l: 0.7, c: 0.4, h: 30 }
  assert.ok(
    srgbChannels(wanted).some((channel) => channel < 0 || channel > 1),
    "oklch(0.7 0.4 30) was supposed to be outside sRGB"
  )

  const mapped = toSrgbGamut(wanted)
  assert.equal(mapped.l, wanted.l, "lightness must not move")
  assert.equal(mapped.h, wanted.h, "hue must not move")
  assert.ok(mapped.c < wanted.c, "chroma should have been reduced")
  assert.ok(mapped.c > 0.1, `chroma collapsed to ${mapped.c} — that is clipping, not mapping`)
  for (const channel of srgbChannels(mapped)) {
    assert.ok(
      channel >= -1e-4 && channel <= 1 + 1e-4,
      `mapped colour still leaves sRGB: ${channel}`
    )
  }

  // The reduction is maximal: a hair more chroma leaves the gamut again.
  const greedier = { ...mapped, c: mapped.c + 1e-3 }
  assert.ok(
    srgbChannels(greedier).some((channel) => channel < -1e-4 || channel > 1 + 1e-4),
    "a greater chroma also fits, so the search stopped short"
  )
})

test("a ratio is reported against the colour that is actually emitted", () => {
  // Before the gamut map this was the whole bug: the ratio was computed from
  // per-channel clamping, which is a different colour from the one the
  // stylesheet carried and a different one again from what a browser paints.
  const cases: Oklch[] = [
    { l: 0.7, c: 0.4, h: 30 },
    { l: 0.5, c: 0.35, h: 150 },
    { l: 0.95, c: 0.3, h: 250 },
    { l: 1, c: 0.0426, h: 272.28 },
  ]
  for (const color of cases) {
    for (const against of [WHITE, BLACK]) {
      const emitted = parseOklch(formatOklch(color))
      assert.ok(emitted, "formatOklch must round-trip through parseOklch")
      assert.ok(
        Math.abs(contrastRatio(color, against) - contrastRatio(emitted, against)) < 1e-3,
        `${formatOklch(color)}: the reported ratio is not the emitted colour's`
      )
    }
  }
})

test("contrastRatio agrees with culori's own WCAG implementation", () => {
  // Independent code path (culori converts oklch → oklab → lrgb with its own
  // matrices) over every in-gamut colour the shipped themes carry.
  let compared = 0
  let worst = 0
  for (const preset of THEME_PRESETS) {
    for (const scheme of ["light", "dark"] as const) {
      const vars = tunedVars(
        { ...preset.cssVars.theme, ...preset.cssVars[scheme] },
        scheme
      )
      const colors = Object.values(vars)
        .map(parseOklch)
        .filter((color): color is Oklch => color !== null)
        .filter((color) =>
          srgbChannels(color).every((channel) => channel >= 0 && channel <= 1)
        )
      const background = colors[0]
      if (!background) continue
      for (const color of colors) {
        const mine = contrastRatio(color, background)
        const theirs = wcagContrast(
          { mode: "oklch", ...color },
          { mode: "oklch", ...background }
        )
        worst = Math.max(worst, Math.abs(mine - theirs))
        compared++
      }
    }
  }
  assert.ok(compared > 100, `only ${compared} pairs compared`)
  assert.ok(worst < 1e-6, `worst disagreement with culori was ${worst}`)
})

test("a theme shipping hex or hsl now reaches the repair path", () => {
  // Every token below is legal CSS and none of it is `oklch(…)`, which is all
  // the old parser understood: the pair used to be passed through at 1.5:1.
  const vars = {
    background: "#ffffff",
    foreground: "hsl(0 0% 72%)",
    card: "rgb(255, 255, 255)",
    "card-foreground": "oklab(0.8 0 0)",
    muted: "color(srgb 1 1 1)",
    "muted-foreground": "#b4b4b4",
  }
  const before = contrastRatio(parseOklch(vars.foreground)!, parseOklch(vars.background)!)
  assert.ok(before < 4.5, `the fixture is supposed to fail AA, it is ${before}`)

  const fixes = contrastFixes(vars, "standard")
  for (const token of ["foreground", "card-foreground", "muted-foreground"]) {
    const fixed = fixes[token]
    assert.ok(fixed, `${token} was left unrepaired`)
    assert.match(fixed, /^oklch\(/, `${token} must come back out as oklch()`)
    assert.ok(
      contrastRatio(parseOklch(fixed)!, WHITE) >= 4.5 - 0.001,
      `${token} is still ${contrastRatio(parseOklch(fixed)!, WHITE).toFixed(2)}:1 on white`
    )
  }
})

test("a translucent token is left alone rather than repaired opaque", () => {
  assert.equal(parseOklch("oklch(0.9 0.02 120 / 0.4)"), null)
  assert.equal(parseOklch("#ffffff80"), null)
  assert.equal(parseOklch("not-a-colour"), null)
  assert.equal(parseOklch(undefined), null)
})

test("parseOklch reads the notation the themes ship, exactly", () => {
  assert.deepEqual(parseOklch("oklch(0.62 0.19 259.81)"), {
    l: 0.62,
    c: 0.19,
    h: 259.81,
  })
  // Percentages: lightness against 100%, chroma against 0.4, per css-color-4.
  const pct = parseOklch("oklch(62% 47.5% 259.81)")!
  assert.ok(Math.abs(pct.l - 0.62) < 1e-9 && Math.abs(pct.c - 0.19) < 1e-9)
  // A grey has no hue to keep.
  assert.equal(parseOklch("oklch(0.145 0 0)")!.h, 0)
})

test("a repair is the smallest lightness change that clears the bar", () => {
  const vars = {
    background: "oklch(1 0 0)",
    foreground: "oklch(0.92 0.03 250)",
  }
  const fixed = parseOklch(contrastFixes(vars, "standard").foreground)!
  const original = parseOklch(vars.foreground)!
  assert.ok(fixed.l < original.l, "white background: the ink has to go darker")
  assert.ok(contrastRatio(fixed, WHITE) >= 4.5 - 0.001)
  // One step of the grid `formatOklch` emits, back toward the theme's own
  // value, has to fail — otherwise the repair took more than it needed.
  assert.ok(
    contrastRatio({ ...fixed, l: fixed.l + 1e-4 }, WHITE) < 4.5,
    `l=${fixed.l} is not minimal: a lighter value also clears AA`
  )
  // The old fixed 0.008 walk could overshoot by a whole step; the search must
  // land inside one.
  assert.ok(
    contrastRatio({ ...fixed, l: fixed.l + 0.008 }, WHITE) < 4.5,
    "the repair overshot by more than a step of the walk it replaced"
  )
})

test("every repaired token is emitted inside sRGB", () => {
  let repaired = 0
  const perLevel: Record<string, number> = {}
  for (const preset of THEME_PRESETS) {
    for (const scheme of ["light", "dark"] as const) {
      const base = tunedVars(
        { ...preset.cssVars.theme, ...preset.cssVars[scheme] },
        scheme
      )
      for (const level of CONTRAST_LEVELS) {
        const fixes = contrastFixes(base, level)
        for (const [token, value] of Object.entries(fixes)) {
          repaired++
          perLevel[level] = (perLevel[level] ?? 0) + 1
          const color = parseOklch(value)
          assert.ok(color, `${preset.id}/${scheme}/${level}: ${token} is unparseable`)
          for (const channel of srgbChannels(color)) {
            assert.ok(
              channel >= -1e-3 && channel <= 1 + 1e-3,
              `${preset.id}/${scheme}/${level}: ${token} = ${value} is outside sRGB (${channel})`
            )
          }
          // Emitting is idempotent: what the stylesheet carries is a fixed
          // point of the gamut map, so re-serializing it never moves it.
          assert.equal(formatOklch(color), value)
          assert.equal(formatOklch(toOklch({ mode: "oklch", ...color })! as Oklch), value)
        }
      }
    }
  }
  console.log(
    `repaired tokens across ${THEME_PRESETS.length} themes × 2 modes: ${repaired} ` +
      `(${CONTRAST_LEVELS.map((level) => `${level} ${perLevel[level] ?? 0}`).join(", ")})`
  )
  assert.ok(repaired > 0, "no theme needed any repair at all — check the fixtures")
})
