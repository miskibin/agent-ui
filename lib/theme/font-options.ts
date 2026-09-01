/**
 * Typeface choice, independent of the theme preset.
 *
 * A tweakcn theme carries its own `font-sans` / `font-mono`, which is right
 * for the preset cards and wrong as a hard rule: the typeface is the single
 * most personal thing about a UI you read all day, and picking one should not
 * mean picking a whole palette. So an override lives in Appearance settings
 * and, when set, is written straight onto <html> — an inline custom property
 * outranks the `[data-theme]` block every preset is emitted into.
 *
 * Data-only, like `./fonts`: `app/fonts.ts` owns the `next/font` loaders (they
 * need literal options), this module only names the variables they define. A
 * stack whose first family is not one we load still works — it just falls
 * through to whatever the machine has, which is the point of the system
 * entries.
 */

export type FontRole = "sans" | "mono"

export type FontChoice = {
  /** Persisted in settings.json. `""` means "whatever the theme says". */
  id: string
  label: string
  /** One line under the label in Settings. */
  description: string
  /** CSS value written to `--font-sans` / `--font-mono`. */
  stack: string
}

/** The id that hands the decision back to the theme preset. */
export const FOLLOW_THEME = ""

/**
 * The chain ChatGPT itself falls back through. Söhne is licensed, not
 * webfont-free, so it cannot be shipped here — Inter is the closest grotesque
 * we already load, and everything after it is verbatim what OpenAI's own
 * stack lands on when Söhne is missing.
 */
const CHATGPT_STACK =
  'var(--font-inter), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, "Noto Sans", sans-serif, "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji"'

const SYSTEM_SANS_STACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif'

const SYSTEM_MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

export const SANS_FONTS: FontChoice[] = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    description: "Söhne's fallback chain, led by Inter — the closest we can ship.",
    stack: CHATGPT_STACK,
  },
  {
    id: FOLLOW_THEME,
    label: "Theme default",
    description: "Whatever typeface the selected theme was designed with.",
    stack: "",
  },
  {
    id: "inter",
    label: "Inter",
    description: "Neutral UI grotesque.",
    stack: "var(--font-inter), sans-serif",
  },
  {
    id: "geist",
    label: "Geist",
    description: "Vercel's UI face — a touch wider than Inter.",
    stack: "var(--font-geist), sans-serif",
  },
  {
    id: "dm-sans",
    label: "DM Sans",
    description: "Low contrast, geometric, friendly.",
    stack: "var(--font-dm-sans), sans-serif",
  },
  {
    id: "montserrat",
    label: "Montserrat",
    description: "Wide and geometric; heavier presence at small sizes.",
    stack: "var(--font-montserrat), sans-serif",
  },
  {
    id: "system",
    label: "System",
    description: "Your OS's own UI font. Loads nothing.",
    stack: SYSTEM_SANS_STACK,
  },
]

export const MONO_FONTS: FontChoice[] = [
  {
    id: FOLLOW_THEME,
    label: "Theme default",
    description: "Whatever the selected theme pairs with its UI face.",
    stack: "",
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    description: "Tall x-height, generous spacing.",
    stack: "var(--font-jetbrains-mono), monospace",
  },
  {
    id: "fira-code",
    label: "Fira Code",
    description: "Fira Mono with programming ligatures.",
    stack: "var(--font-fira-code), monospace",
  },
  {
    id: "source-code-pro",
    label: "Source Code Pro",
    description: "Adobe's compact, quiet code face.",
    stack: "var(--font-source-code-pro), monospace",
  },
  {
    id: "system",
    label: "System",
    description: "Your OS's own monospace. Loads nothing.",
    stack: SYSTEM_MONO_STACK,
  },
]

const BY_ROLE: Record<FontRole, FontChoice[]> = {
  sans: SANS_FONTS,
  mono: MONO_FONTS,
}

/** Unknown / retired ids (older settings.json files) fall back to the theme. */
export function findFont(role: FontRole, id: string | undefined): FontChoice {
  const list = BY_ROLE[role]
  return (
    list.find((font) => font.id === id) ??
    list.find((font) => font.id === FOLLOW_THEME)!
  )
}

/** `""` for "follow the theme", otherwise the stack to write onto <html>. */
export function fontStack(role: FontRole, id: string | undefined): string {
  return findFont(role, id).stack
}

/** `{ chatgpt: "var(--font-inter), …" }` — what the pre-paint guard needs. */
export function fontStackMap(role: FontRole): Record<string, string> {
  const map: Record<string, string> = {}
  for (const font of BY_ROLE[role]) {
    if (font.stack) map[font.id] = font.stack
  }
  return map
}
