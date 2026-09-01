import "server-only"

import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

/**
 * Path handling shared by the two filesystem routes (`/api/fs/validate` and
 * `/api/fs/list`). Server-only: `node:os` and `node:path` have no business in
 * the client bundle, where a path is only ever a string to display.
 */

/** `~` and `~/foo` — the only shell-ism a hand-typed path really needs. */
export function expandHome(input: string): string {
  const path =
    input === "~" || input.startsWith("~/") || input.startsWith("~\\")
      ? `${homedir()}${input.slice(1)}`
      : input
  return isAbsolute(path) ? resolve(path) : path
}

/** Where the browser starts when nothing has been typed yet. */
export function defaultBrowseRoot(): string {
  return homedir()
}
