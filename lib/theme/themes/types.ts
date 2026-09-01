/**
 * The shape of a tweakcn / shadcn registry theme item, kept as close to the
 * registry JSON as possible so importing a new theme is a fetch and nothing
 * else. `lib/theme/apply.ts` turns these records into CSS verbatim — every
 * key becomes `--<key>`, with no per-token mapping in the app.
 */

export type TweakcnVars = Record<string, string>

export type TweakcnTheme = {
  /** Registry item name; also the id persisted in settings.json. */
  id: string
  /** Display name on the preset card. */
  name: string
  /** One line of copy under the name. */
  description: string
  cssVars: {
    /** Mode-independent: fonts, radius, tracking scale. */
    theme: TweakcnVars
    light: TweakcnVars
    dark: TweakcnVars
  }
}
