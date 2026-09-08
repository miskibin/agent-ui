// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * A logo for every folder in the sidebar.
 *
 * A grouped sidebar reads as a list of *projects*, and a list of projects is
 * scanned by shape long before it is read: a row of identical folder glyphs
 * throws that away and makes the user read three headers to find the one they
 * meant. So each folder gets a mark of its own — the project's own icon where
 * it ships one, and a coloured monogram derived from its path where it does
 * not, which is stable across reloads and machines because it is a pure
 * function of the path.
 *
 * The exception is a folder that is not a project: a chat opened in the home
 * directory, in `Documents`, or at the filesystem root is not a thing with an
 * identity, and dressing it up as one is a lie the eye then has to unlearn. It
 * gets the plain folder glyph.
 *
 * This module is pure and free of `node:` — the scan that reads the disk is
 * `lib/folder-logo-scan.ts`, and the sidebar renders from what it returns.
 */

/** What the sidebar draws for one folder. */
export type FolderLogo =
  /**
   * An icon file found inside the folder, inlined as a `data:` URL. Inlined
   * rather than served from a route so the whole answer survives one
   * localStorage write and the sidebar paints its logos before any fetch.
   */
  | { kind: "icon"; src: string }
  /** Not a project: the home directory, a standard user folder, the root. */
  | { kind: "generic" }
  /** A project with no icon of its own: its initials, coloured by its path. */
  | { kind: "monogram"; text: string; hue: number }

/** One folder's logo, keyed by the `cwd` exactly as the chat stored it. */
export type FolderLogoMap = Record<string, FolderLogo>

/**
 * Two characters at most, upper case, from the folder's own name.
 *
 * A name that reads as words — `agent-ui`, `chat_components`, `my.app` — gives
 * up its initials, which is what makes `agent-ui` (AU) and `agent-api` (AA)
 * tell apart at a glance. A single word gives its first two letters instead,
 * because one letter collides constantly. Digits count as letters: `2fa` is as
 * good a mark as any.
 */
export function folderMonogram(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    // A leading `.` or `@` is punctuation, not a word: `.config` reads as
    // "config" and `@scope` as "scope".
    .map((word) => word.replace(/^[_-]+/, ""))
    .filter(Boolean)
  if (words.length === 0) return "·"
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/**
 * A hue in [0, 360) for a path — the whole colour, since saturation and
 * lightness come from the theme so the mark stays legible in every preset and
 * in both modes.
 *
 * FNV-1a over the path rather than the name: two `web` folders in two
 * checkouts are two projects and should not share a colour. 32-bit unsigned
 * arithmetic throughout, so the answer is the same in every JS engine.
 */
export function folderHue(path: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index)
    // `Math.imul` is the 32-bit multiply; `>>> 0` keeps it unsigned.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 360
}
