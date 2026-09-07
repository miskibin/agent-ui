// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * What a tool call was actually *about*: the files it named and the command it
 * ran, dug out of a payload whose shape nobody controls.
 *
 * Every harness spells this differently, and more than one of them nests it.
 * A flat read of `args.path` finds the Claude Code edit and misses the ACP
 * update, whose paths live under `locations[]`; it finds a cursor shell call
 * and misses the one that put its arguments under `rawInput`. The journal then
 * records an edit with no file and a shell call with no command, and the
 * handoff built from it says an agent did something, somewhere.
 *
 * So the payload is walked instead of indexed — a few known container keys
 * deep, a few known name keys wide, both bounded hard because this runs on
 * every tool event of every turn. Pure, and free of `node:`.
 */

/** Deepest nesting followed. Past this a payload is a document, not a call. */
const MAX_DEPTH = 4
/** Most paths one call contributes. A handoff quotes files, it does not list them. */
const MAX_PATHS = 8

/** Keys whose value is a path, across every harness the app speaks to. */
const PATH_KEYS = [
  "path",
  "filePath",
  "file_path",
  "relativePath",
  "relative_path",
  "filename",
  "file_name",
  "fileName",
  "newPath",
  "new_path",
  "oldPath",
  "old_path",
  "target_file",
  "targetFile",
  "abs_path",
  "absPath",
  "file",
] as const

/** Keys worth descending into. Anything else is payload, not structure. */
const CONTAINER_KEYS = [
  "locations",
  "item",
  "input",
  "result",
  "rawInput",
  "raw_input",
  "data",
  "changes",
  "paths",
  "files",
  "edits",
  "arguments",
] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * The file paths a payload names, deduped, in the order the walk reaches
 * them (its own container order, not the object's key order).
 *
 * Bare strings inside a path-shaped container (`paths: ["a.ts", "b.ts"]`)
 * count; a bare string anywhere else does not, because a tool's prose is full
 * of them.
 */
export function collectToolPaths(
  payload: unknown,
  options: { maxPaths?: number; maxDepth?: number } = {}
): string[] {
  const maxPaths = options.maxPaths ?? MAX_PATHS
  const maxDepth = options.maxDepth ?? MAX_DEPTH
  const found: string[] = []
  const seen = new Set<string>()

  const push = (value: unknown) => {
    const candidate = asTrimmedString(value)
    if (!candidate || seen.has(candidate)) return
    seen.add(candidate)
    found.push(candidate)
  }

  const walk = (value: unknown, depth: number, inPathList: boolean) => {
    if (depth > maxDepth || found.length >= maxPaths) return
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (found.length >= maxPaths) return
        if (inPathList && typeof entry === "string") push(entry)
        else walk(entry, depth + 1, inPathList)
      }
      return
    }
    const record = asRecord(value)
    if (!record) return
    for (const key of PATH_KEYS) {
      if (found.length >= maxPaths) return
      push(record[key])
    }
    for (const key of CONTAINER_KEYS) {
      if (found.length >= maxPaths) return
      if (!(key in record)) continue
      walk(record[key], depth + 1, key === "paths" || key === "files")
    }
  }

  walk(payload, 0, false)
  return found.slice(0, maxPaths)
}

/**
 * Some harnesses append `<exited with exit code 1>` to the command they echo
 * back. The exit code travels in its own field, so the same fact printed
 * inside the command line is noise the journal would otherwise store forever.
 */
export function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const match = /^([\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/i.exec(trimmed)
  const output = (match?.[1] ?? trimmed).trim()
  return output.length > 0 ? output : undefined
}

/** `["npm", "test"]` → `npm test`; a string stays as it is. */
function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value)
  if (direct) return direct
  if (!Array.isArray(value)) return undefined
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((part): part is string => part !== undefined)
  return parts.length > 0 ? parts.join(" ") : undefined
}

/** A `run \`npm test\`` title is the last thing left when nothing carried args. */
function commandFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined
  return /`([^`]+)`/.exec(title)?.[1]?.trim() || undefined
}

/**
 * The command a shell-shaped call ran, under the five spellings the harnesses
 * use, then `executable` + `args`, then a backticked command in the row's own
 * title. Whatever it finds comes back without a trailing exit-code echo.
 */
export function extractToolCommand(
  data: Record<string, unknown> | undefined,
  title?: string
): string | undefined {
  const item = asRecord(data?.item)
  const itemInput = asRecord(item?.input)
  const itemResult = asRecord(item?.result)
  const rawInput = asRecord(data?.rawInput) ?? asRecord(data?.raw_input)
  const direct = [
    normalizeCommandValue(data?.command),
    normalizeCommandValue(data?.cmd),
    normalizeCommandValue(data?.script),
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(rawInput?.command),
  ].find((candidate) => candidate !== undefined)
  if (direct) return stripTrailingExitCode(direct)

  const executable = asTrimmedString(rawInput?.executable)
  const args = normalizeCommandValue(rawInput?.args)
  if (executable) {
    return stripTrailingExitCode(args ? `${executable} ${args}` : executable)
  }
  return stripTrailingExitCode(commandFromTitle(title))
}

/**
 * A command line split at the shell operators that start a new command, so
 * `cd api && npm test` is two commands and the second one is still a test run.
 * Quoting is ignored on purpose: a `&&` inside a string is rare, and the worst
 * it costs is one extra segment nothing matches.
 */
export function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

/**
 * The program a command line runs: the first token, minus a leading path, a
 * Windows extension, and any `FOO=bar` assignments or `sudo`/`env` wrappers in
 * front of it. Lowercased, because it is only ever compared.
 *
 * Deliberately simple — the full tokenizer, with quoting and redirection,
 * lives in the vendored components. This one only has to be right about
 * `npm`, `pytest` and their neighbours.
 */
export function commandProgram(command: string): string {
  for (const token of command.trim().split(/\s+/)) {
    if (!token) continue
    // `NODE_ENV=test npm test` — the assignment is not the program.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
    const bare = token.split(/[\\/]/).pop() ?? token
    const name = bare.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase()
    if (name === "sudo" || name === "env" || name === "command" || name === "time") {
      continue
    }
    return name
  }
  return ""
}

/** The command's program and the rest of its tokens. */
export function commandTokens(command: string): { program: string; args: string[] } {
  const program = commandProgram(command)
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  const index = tokens.findIndex(
    (token) => (token.split(/[\\/]/).pop() ?? token).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase() === program
  )
  return { program, args: index >= 0 ? tokens.slice(index + 1) : [] }
}
