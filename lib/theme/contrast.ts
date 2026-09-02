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
 *    its chroma.
 *
 * Everything is pure and string-in/string-out: `oklch(L C H)` is the shape
 * every shipped theme uses, and anything this module cannot parse is passed
 * through untouched rather than guessed at.
 */

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

const OKLCH_RE =
  /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*\)$/i

/** `oklch(0.62 0.19 259.81)` → components, or null for any other notation. */
export function parseOklch(value: string | undefined): Oklch | null {
  const match = OKLCH_RE.exec((value ?? "").trim())
  if (!match) return null
  const [, rawL, rawC, rawH] = match
  const l = rawL.endsWith("%") ? parseFloat(rawL) / 100 : parseFloat(rawL)
  // Chroma's percentage reference is 0.4, per css-color-4.
  const c = rawC.endsWith("%") ? (parseFloat(rawC) / 100) * 0.4 : parseFloat(rawC)
  const h = parseFloat(rawH)
  if (![l, c, h].every(Number.isFinite)) return null
  return { l, c, h }
}

function round(value: number, places: number) {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

export function formatOklch({ l, c, h }: Oklch): string {
  return `oklch(${round(l, 4)} ${round(c, 4)} ${round(h, 2)})`
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

function toLinearSrgb({ l, c, h }: Oklch) {
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
  ].map((channel) => Math.min(1, Math.max(0, channel)))
}

/** WCAG 2.1 relative luminance. The clamp above is the gamut mapping. */
function luminance(color: Oklch): number {
  const [r, g, b] = toLinearSrgb(color)
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

const STEP = 0.008
const MAX_STEPS = 130

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
      const direction = background.l < 0.5 ? STEP : -STEP
      let candidate = foreground
      for (let step = 0; step < MAX_STEPS; step++) {
        const l = Math.min(1, Math.max(0, candidate.l + direction))
        if (l === candidate.l) break
        candidate = { ...candidate, l }
        if (contrastRatio(candidate, background) >= min) break
      }
      out[fg] = formatOklch(candidate)
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
