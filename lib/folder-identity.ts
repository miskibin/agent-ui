// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * When two spellings of a folder are the same folder.
 *
 * The app compares stored working folders constantly — to decide whether a
 * backend session may be resumed, and to file a chat under a sidebar section —
 * and the strings it compares came from a folder picker, from a hand-typed
 * settings file and from a CLI's own idea of the cwd. On Windows those differ
 * without meaning anything: `C:\\repo`, `C:\\repo\\` and `c:/repo` are one place,
 * and a chat that opened as one and resumed as another would silently lose its
 * session or grow a second sidebar section.
 *
 * Only the *comparison* is normalized. What the app stores stays exactly as it
 * was given, because that string is what gets shown to the user and handed to
 * a process as its cwd, and neither wants our idea of the canonical spelling.
 *
 * POSIX paths are left alone apart from trailing separators: a case-folding
 * comparison there would be wrong, `/tmp/A` and `/tmp/a` being two folders.
 */

/** `C:\\x` or `C:/x` — an absolute path on a lettered drive. */
function isWindowsDrivePath(value: string) {
  return /^[a-zA-Z]:([/\\]|$)/.test(value)
}

/** `\\\\server\\share` — a UNC path. */
function isUncPath(value: string) {
  return value.startsWith("\\\\")
}

/**
 * A root is its own trailing separator, so it keeps it. The drive separator is
 * required: a bare `C:` is *not* the drive root — it means "the current
 * directory on C:" — and treating it as canonical would leave `C:` and `C:\\`
 * comparing as two different folders.
 */
function isRootPath(value: string) {
  return value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]$/.test(value)
}

/** Trailing separators removed, except from a root; a bare `C:` becomes `C:\\`. */
export function normalizeFolder(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || isRootPath(trimmed)) return trimmed
  // A POSIX path may legitimately contain a backslash in a file name, so only
  // a Windows-shaped one has both separators trimmed.
  const stripped = trimmed.startsWith("/")
    ? trimmed.replace(/\/+$/, "")
    : trimmed.replace(/[\\/]+$/, "")
  if (stripped.length === 0) return trimmed
  return /^[a-zA-Z]:$/.test(stripped) ? `${stripped}\\` : stripped
}

/**
 * The key two folders are the same under. Windows drive and UNC paths fold
 * their separators to `\\` and lowercase; everything else only loses trailing
 * separators.
 */
export function normalizeFolderForComparison(value: string | undefined): string {
  const normalized = normalizeFolder(value ?? "")
  return isWindowsDrivePath(normalized) || isUncPath(normalized)
    ? normalized.replaceAll("/", "\\").toLowerCase()
    : normalized
}

/** Whether two stored folders name the same place; two empties do. */
export function sameFolder(a?: string, b?: string): boolean {
  return normalizeFolderForComparison(a) === normalizeFolderForComparison(b)
}
