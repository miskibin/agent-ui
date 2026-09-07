/**
 * Contrast — the arithmetic half of the theme system.
 *
 * Two jobs, both done once at serialization time in `lib/theme/apply.ts` so
 * nothing here ever runs in a render:
 *
 * 1. **Accent harmonisation.** A registry theme's `accent` is whatever its
 *    author picked, and the app leans on it hard: every hover, every selected
 *    sidebar row, every focused menu item. Some of those picks are a tint of
 *    the background (fine), and some are a near-white slab in dark mode
 *    (`notebook`: `accent` oklch(0.907) under a foreground of oklch(0.895) —
 *    a 1.04:1 pair, i.e. white on white). So the app derives the accent itself:
 *    a tint of the theme's *own* primary over its *own* background. It stays
 *    the theme's colour — warmer themes stay warm, `graphite` stays grey —
 *    but it is now the same shape everywhere, always reads against the
 *    foreground, and carries more of the theme's hue than most of the
 *    originals did.
 *
 * 2. **Contrast repair.** Settings → Appearance exposes three levels. `high`
 *    holds every text pair to WCAG AAA, `standard` to AA, and `soft` relaxes
 *    the greys for people who find full contrast harsh — with a floor, so
 *    "soft" can never mean "unreadable". Repair only ever moves *lightness*,
 *    and only on the foreground half of a pair, so a theme keeps its hue and
 *    its chroma — and it moves it by the *least* amount that clears the bar,
 *    so a theme keeps as much of its own intent as the bar allows.
 *
 * Everything is pure and string-in/string-out. Input is any CSS colour a
 * theme might ship; output is always `oklch(L C H)`, which is the shape the
 * stylesheet in `apply.ts` expects.
 */

import {
  modeHsl,
  modeOklab,
  modeOklch,
  modeRgb,
  parse as parseCssColor,
  // Renamed on the way in: `useMode` registers a colour space, but the name
  // trips the react-hooks rule, which reads any `use*` call at module scope as
  // a hook called outside a component.
  useMode as registerMode,
} from "culori/fn"

export type ContrastLevel = "soft" | "standard" | "high"

export const CONTRAST_LEVELS: readonly ContrastLevel[] = [
  "soft",
  "standard",
  "high",
]

export const DEFAULT_CONTRAST: ContrastLevel = "standard"

export function isContrastLevel(value: unknown): value is ContrastLevel {
  return (
    typeof value === "string" &&
    (CONTRAST_LEVELS as readonly string[]).includes(value)
  )
}

type Vars = Record<string, string>

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

export type Oklch = { l: number; c: number; h: number }

/**
 * Parsing is the one thing this module does not hand-roll, and `culori` is the
 * one runtime dependency it takes — a deliberate exception to the app's
 * no-new-dependencies rule, made because the hand-written parser it replaces
 * understood exactly one notation. A theme shipping `#1a1a1a`, `hsl(…)`,
 * `color(display-p3 …)` or `oklab(…)` was passed through untouched, which
 * meant it silently skipped *both* contrast repair and accent derivation and
 * shipped whatever white-on-white pair it had. Every notation now reaches the
 * repair path.
 *
 * It is pulled in the tree-shakable way — `culori/fn` plus explicit `useMode`
 * registrations, never the `culori` barrel, which drags in every colour space
 * the library knows — and it is used for nothing but parsing and the
 * conversion into OKLCH. The gamut mapping and the WCAG arithmetic below are
 * this module's own, so the numbers the repair loop solves against are the
 * numbers the tests assert.
 */
registerMode(modeRgb) // hex, `rgb()`, the named colours, `color(srgb …)`
registerMode(modeHsl)
registerMode(modeOklab) // the space oklch is converted through
const toOklchColor = registerMode(modeOklch)

function normalizeHue(h: number): number {
  const wrapped = h % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

/**
 * Any CSS colour → OKLCH components, or null when there is nothing sensible to
 * do with it. Two things still come back null, and both mean "leave the
 * theme's own value alone": a notation no CSS parser accepts, and a colour
 * carrying transparency — a WCAG ratio against a translucent token is
 * meaningless, and repairing one would drop the alpha on the way out.
 */
export function parseOklch(value: string | undefined): Oklch | null {
  const raw = (value ?? "").trim()
  if (!raw) return null
  const parsed = parseCssColor(raw)
  if (!parsed) return null
  if (parsed.alpha !== undefined && parsed.alpha < 1) return null
  const color = toOklchColor(parsed)
  if (!color) return null
  const { l, c } = color
  if (!Number.isFinite(l) || !Number.isFinite(c)) return null
  // culori leaves the hue undefined for an achromatic colour; at c = 0 any
  // hue paints the same pixel, so 0 is as good as the theme's own.
  const h = color.h
  return { l, c, h: typeof h === "number" && Number.isFinite(h) ? normalizeHue(h) : 0 }
}

function round(value: number, places: number) {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/**
 * The one exit point, and the one place chroma can move: whatever comes out is
 * gamut-mapped, so the colour the stylesheet carries is a colour a display can
 * actually show — a promise of 4.5:1 made about a chroma no screen can reach
 * is not a promise about anything. Repair itself still only ever moves
 * lightness; what this drops was never renderable to begin with.
 */
export function formatOklch(color: Oklch): string {
  // Rounded first and mapped second, because the rounding is part of the
  // colour: a chroma solved to the edge of the gamut and *then* rounded up by
  // half a step is back outside it, which is exactly the kind of hairline miss
  // the whole exercise is about. A reduced chroma is snapped down for the same
  // reason — the gamut is convex in chroma, so down is always still inside.
  const rounded = {
    l: round(color.l, 4),
    c: round(color.c, 4),
    h: round(color.h, 2),
  }
  const mapped = toSrgbGamut(rounded)
  const c =
    mapped.c < rounded.c
      ? Math.max(0, Math.floor(mapped.c * 1e4) / 1e4)
      : rounded.c
  return `oklch(${rounded.l} ${round(c, 4)} ${rounded.h})`
}

function toOklab({ l, c, h }: Oklch) {
  const rad = (h * Math.PI) / 180
  return { l, a: c * Math.cos(rad), b: c * Math.sin(rad) }
}

function fromOklab({ l, a, b }: { l: number; a: number; b: number }): Oklch {
  const c = Math.hypot(a, b)
  const h = c < 1e-6 ? 0 : (Math.atan2(b, a) * 180) / Math.PI
  return { l, c, h: h < 0 ? h + 360 : h }
}

/** `ratio` of `a`, the rest `b` — the same interpolation `color-mix(in oklab)` does. */
export function mixOklch(a: Oklch, b: Oklch, ratio: number): Oklch {
  const x = toOklab(a)
  const y = toOklab(b)
  const t = Math.min(1, Math.max(0, ratio))
  return fromOklab({
    l: x.l * t + y.l * (1 - t),
    a: x.a * t + y.a * (1 - t),
    b: x.b * t + y.b * (1 - t),
  })
}

/** Linear-light sRGB, unclamped — the channels run past 0…1 outside the gamut. */
function toLinearSrgbRaw({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ]
}

/** Slack for the cube roots and the matrix, not for the gamut. */
const GAMUT_EPSILON = 1e-4
/** Half a step of the four decimals `formatOklch` emits. */
const CHROMA_RESOLUTION = 5e-5

function inSrgbGamut(color: Oklch): boolean {
  return toLinearSrgbRaw(color).every(
    (channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON
  )
}

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
/**
 * The greatest chroma at this lightness and hue that sRGB can actually show.
 *
 * This is what the module used to do by clamping each linear channel into
 * 0…1 — which is not gamut mapping at all: clamping moves hue and lightness
 * both, and it moves them differently per channel, so an out-of-gamut
 * `oklch(0.7 0.4 30)` was being measured as a colour no browser would ever
 * paint. Holding L and h and binary-searching C is the same reduction CSS
 * Color 4 describes, and it lands on a colour that looks like what the theme
 * asked for.
 *
 * Most tokens are in gamut already: those return untouched, and pay one matrix
 * multiply for the check.
 */
export function toSrgbGamut(color: Oklch): Oklch {
  if (color.c <= 0 || inSrgbGamut(color)) return color
  let low = 0
  let high = color.c
  const steps = Math.max(
    1,
    Math.ceil(Math.log2(color.c) - Math.log2(CHROMA_RESOLUTION))
  )
  for (let step = 0; step < steps; step++) {
    const mid = (low + high) / 2
    if (inSrgbGamut({ ...color, c: mid })) low = mid
    else high = mid
  }
  return { ...color, c: low }
}

/**
 * WCAG 2.1 relative luminance, of the colour a display would actually show:
 * gamut-mapped first, and only then clamped — what is left to clamp after the
 * search above is the `GAMUT_EPSILON` of arithmetic slack, not colour.
 */
function luminance(color: Oklch): number {
  const [r, g, b] = toLinearSrgbRaw(toSrgbGamut(color)).map((channel) =>
    Math.min(1, Math.max(0, channel))
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: Oklch, b: Oklch): number {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/* -------------------------------------------------------------------------- */
/* Accent harmonisation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How much primary goes into the accent. Dark mode takes more because a tint
 * of a dark background has far less room to separate itself than a tint of a
 * light one.
 */
const ACCENT_TINT = { light: 0.15, dark: 0.24 }
/** The sidebar tint is a touch stronger — a selected chat should be obvious. */
const SIDEBAR_TINT = { light: 0.18, dark: 0.3 }

/**
 * How readable the surface's own ink has to stay on the tint. Fixed at AA
 * rather than tied to the contrast level, so changing level never moves the
 * hover colour: this is the bar for text that lands on an accent *without*
 * being repainted `accent-foreground` — a stray `text-foreground` child, or a
 * component the app composed around rather than through.
 */
const ACCENT_MIN_RATIO = 4.5
/** Below this the "tint" is just the background again. */
const MIN_TINT = 0.04

export type Scheme = "light" | "dark"

/**
 * `primary` over `surface`, weakened until `ink` reads on it. Weakening always
 * helps: every step moves the tint back toward the surface, and the surface is
 * where `ink` already has its full contrast.
 */
function readableTint(
  primary: Oklch,
  surface: Oklch,
  ink: Oklch,
  tint: number
): Oklch {
  let amount = tint
  let color = mixOklch(primary, surface, amount)
  while (
    amount > MIN_TINT &&
    contrastRatio(ink, color) < ACCENT_MIN_RATIO
  ) {
    amount -= 0.01
    color = mixOklch(primary, surface, amount)
  }
  return color
}

/**
 * Accent and sidebar-accent, rebuilt from the theme's own primary. Returns
 * only what it can compute; an unparseable primary or background leaves the
 * theme's own values in place.
 */
export function vividAccents(vars: Vars, scheme: Scheme): Vars {
  const out: Vars = {}
  const primary = parseOklch(vars.primary)
  const foreground = parseOklch(vars.foreground)

  const background = parseOklch(vars.background)
  if (primary && background && foreground) {
    out.accent = formatOklch(
      readableTint(primary, background, foreground, ACCENT_TINT[scheme])
    )
    out["accent-foreground"] = formatOklch(foreground)
  }

  const sidebar = parseOklch(vars.sidebar ?? vars.background)
  const sidebarPrimary = parseOklch(vars["sidebar-primary"] ?? vars.primary)
  const sidebarForeground = parseOklch(vars["sidebar-foreground"] ?? vars.foreground)
  if (sidebarPrimary && sidebar && sidebarForeground) {
    out["sidebar-accent"] = formatOklch(
      readableTint(
        sidebarPrimary,
        sidebar,
        sidebarForeground,
        SIDEBAR_TINT[scheme]
      )
    )
    out["sidebar-accent-foreground"] = formatOklch(sidebarForeground)
  }

  return out
}

/* -------------------------------------------------------------------------- */
/* Contrast repair                                                             */
/* -------------------------------------------------------------------------- */

/** `[foreground token, background token]`, background falling back in order. */
type Pair = {
  fg: string
  bg: string[]
  kind: "body" | "secondary" | "glyph" | "line"
}

const PAIRS: Pair[] = [
  { fg: "foreground", bg: ["background"], kind: "body" },
  { fg: "card-foreground", bg: ["card", "background"], kind: "body" },
  { fg: "popover-foreground", bg: ["popover", "background"], kind: "body" },
  { fg: "muted-foreground", bg: ["background"], kind: "body" },
  { fg: "muted-foreground", bg: ["muted"], kind: "body" },
  { fg: "secondary-foreground", bg: ["secondary"], kind: "body" },
  { fg: "accent-foreground", bg: ["accent"], kind: "body" },
  { fg: "sidebar-foreground", bg: ["sidebar", "background"], kind: "body" },
  {
    fg: "sidebar-accent-foreground",
    bg: ["sidebar-accent"],
    kind: "body",
  },
  // The muted greys also land on the accent tints: a menu item's leading icon
  // keeps `text-muted-foreground` while the row is highlighted, and so does a
  // hovered sidebar row's meta before it fades to currentColor.
  { fg: "muted-foreground", bg: ["accent"], kind: "glyph" },
  { fg: "muted-foreground", bg: ["sidebar-accent"], kind: "glyph" },
  { fg: "primary-foreground", bg: ["primary"], kind: "secondary" },
  { fg: "destructive-foreground", bg: ["destructive"], kind: "secondary" },
  { fg: "border", bg: ["background"], kind: "line" },
  { fg: "input", bg: ["background"], kind: "line" },
  { fg: "sidebar-border", bg: ["sidebar", "background"], kind: "line" },
]

/**
 * Minimum ratios per level. `body` is running text, `secondary` the ink on a
 * solid button (large, bold, and a hue the theme chose deliberately — AAA
 * there would repaint every brand colour), `glyph` an icon or a small muted
 * label on a tint, `line` a hairline that only has to be *visible*.
 */
const TARGETS: Record<ContrastLevel, Record<Pair["kind"], number>> = {
  soft: { body: 3.6, secondary: 3, glyph: 2.6, line: 1.15 },
  standard: { body: 4.5, secondary: 3.6, glyph: 3, line: 1.35 },
  high: { body: 7, secondary: 4.5, glyph: 4.5, line: 2.4 },
}

/**
 * Level-specific softening, applied before the floors above. Only `soft` has
 * any: it walks the greys and the hairlines *back* toward the background,
 * which is the whole point of the setting, and the floors then stop it short
 * of illegible.
 */
const SOFTEN: Record<string, number> = {
  "muted-foreground": 0.18,
  border: 0.3,
  input: 0.3,
  "sidebar-border": 0.3,
}

/**
 * Steps of the lightness search. Eighteen halvings of a 0…1 range settle far
 * below the four decimals `formatOklch` emits, so the answer is exact on the
 * grid the stylesheet actually carries.
 */
const LIGHTNESS_STEPS = 18
/** The grid those four decimals describe. */
const LIGHTNESS_GRID = 1e-4

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
/**
 * The *least* lightness change, in `direction`, that takes `base` to `min`
 * against `against` — hue and chroma untouched, which is the rule repair has
 * always followed.
 *
 * It replaces a fixed walk of 130 steps of 0.008, which overshot by up to a
 * full step every time it fired and then kept whatever it landed on. The bar
 * is a floor, not a target: a theme that needs 0.31 of lightness to clear AA
 * should be moved 0.31 and no further, or the repair costs it more of its own
 * palette than the level asked for. Contrast is monotonic in lightness once
 * the direction is away from the background, which is what makes the search
 * valid — and both bounds are known good, so an unreachable target returns the
 * extreme rather than failing.
 */
function solveLightness(
  base: Oklch,
  against: Oklch,
  min: number,
  direction: "lighter" | "darker"
): Oklch {
  if (contrastRatio(base, against) >= min) return base
  const up = direction === "lighter"
  let low = up ? base.l : 0
  let high = up ? 1 : base.l
  for (let step = 0; step < LIGHTNESS_STEPS; step++) {
    const mid = (low + high) / 2
    const clears = contrastRatio({ ...base, l: mid }, against) >= min
    // The known-good end is `high` going lighter and `low` going darker, and
    // a mid that clears always replaces that end — which is what `clears ===
    // up` says. The interval therefore always straddles the answer.
    if (clears === up) high = mid
    else low = mid
  }
  // Settle on the emitted grid, rounding away from the background rather than
  // to nearest: a value that only clears the bar before `formatOklch` rounds
  // it is a value the browser never paints.
  const solved = up ? high : low
  const snapped = up
    ? Math.ceil(solved / LIGHTNESS_GRID) * LIGHTNESS_GRID
    : Math.floor(solved / LIGHTNESS_GRID) * LIGHTNESS_GRID
  return { ...base, l: Math.min(1, Math.max(0, snapped)) }
}

/**
 * The overrides that bring `vars` up to `level`. Only changed tokens come
 * back, so the emitted `[data-contrast]` block stays a handful of lines.
 *
 * Two passes: a token can be the foreground of more than one pair
 * (`muted-foreground` sits on both `background` and `muted`), and a first-pass
 * fix for one can leave the other short.
 */
export function contrastFixes(vars: Vars, level: ContrastLevel): Vars {
  const out: Vars = {}
  const read = (key: string) => parseOklch(out[key] ?? vars[key])

  if (level === "soft") {
    const background = parseOklch(vars.background)
    if (background) {
      for (const [key, amount] of Object.entries(SOFTEN)) {
        const color = parseOklch(vars[key])
        if (color) out[key] = formatOklch(mixOklch(background, color, amount))
      }
    }
  }

  for (let pass = 0; pass < 2; pass++) {
    for (const { fg, bg, kind } of PAIRS) {
      const foreground = read(fg)
      const background = bg.map(read).find(Boolean)
      if (!foreground || !background) continue

      const min = TARGETS[level][kind]
      if (contrastRatio(foreground, background) >= min) continue

      // Away from the background: darker text on a light surface, lighter on
      // a dark one. Lightness only — the hue and chroma are the theme's.
      const direction = background.l < 0.5 ? "lighter" : "darker"
      out[fg] = formatOklch(
        solveLightness(foreground, background, min, direction)
      )
    }
  }

  // A softening that survived both passes unchanged is not worth emitting.
  for (const key of Object.keys(out)) {
    if (out[key] === vars[key]) delete out[key]
  }
  return out
}

/** Base vars for one mode, with the accent already harmonised. */
export function tunedVars(vars: Vars, scheme: Scheme): Vars {
  return { ...vars, ...vividAccents(vars, scheme) }
}
