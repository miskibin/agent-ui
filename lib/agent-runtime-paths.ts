import "server-only"

import path from "node:path"

/**
 * Where the app looks for a harness binary.
 *
 * One line, but it has to be read *late*: `instrumentation.ts` repairs
 * `process.env.PATH` at boot from the user's login shell (`lib/shell-env`),
 * and a module that captured PATH at import time would keep looking in the
 * four directories a macOS desktop launch inherits. So this reads the variable
 * every time it is asked, and every runtime that finds a CLI goes through it.
 */
export function pathDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/** Whether any of `names` exists in a PATH directory. */
export function existsOnPath(
  names: readonly string[],
  exists: (candidate: string) => boolean
): boolean {
  return pathDirs().some((dir) => names.some((name) => exists(path.join(dir, name))))
}
