// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
/**
 * Skills, as the composer and a turn see them.
 *
 * A skill is a folder on this machine — `.claude/skills/<name>/SKILL.md` and
 * its neighbours — that a harness knows how to run. The user names one in the
 * composer with `$name`, the way a file is named with `@path`, and this module
 * is the part of that which is pure string work: what a mention looks like,
 * which mentions a message carries, and what a harness has to be handed
 * instead, since none of them actually reads `$`.
 *
 * Everything here is client-safe on purpose — `send` runs in the browser. The
 * filesystem half lives in `lib/skills-scan.ts`, behind `GET /api/skills`.
 */

export type SkillScope = "project" | "user"

export type DiscoveredSkill = {
  /** What `$name` and `/name` say — the directory's own name (see below). */
  name: string
  /** The `name:` the front matter declared, when it is not the directory's. */
  displayName?: string
  description?: string
  scope: SkillScope
  /** The `SKILL.md` it was read from. */
  path: string
  /** `user-invocable: false` — the harness reserves it for the agent. */
  userInvocable?: boolean
  /** `disable-model-invocation: true` — only the user can start it. */
  userInvocationOnly?: boolean
}

export type DiscoveredCommand = {
  name: string
  description?: string
  /** `argument-hint` from the front matter, shown after the name in the menu. */
  argHint?: string
  scope: SkillScope
  path: string
}

export type SkillCatalog = {
  skills: DiscoveredSkill[]
  commands: DiscoveredCommand[]
}

export const EMPTY_SKILL_CATALOG: SkillCatalog = { skills: [], commands: [] }

/**
 * A `$name` that is a skill mention and not an amount of money. A skill name
 * may open with a digit, so the exclusion is written out: `$20`, `$20k`,
 * `$100M` and `$1e6` stay prose, and every match has to carry a letter.
 *
 * It is the same expression the vendored composer chips on, so what the user
 * sees marked and what a turn dispatches can never be two different sets.
 */
const SKILL_TOKEN_REGEX =
  /(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g

export type SkillMention = {
  name: string
  /** Offset of the `$`. */
  start: number
  /** Offset just past the name. */
  end: number
}

function names(known: Iterable<string> | ReadonlySet<string>): ReadonlySet<string> {
  return known instanceof Set ? known : new Set(known)
}

/**
 * Every mention in `text` that names one of `known`, in the order they appear.
 * A mention of something nobody discovered stays prose — a `$HOME` in a shell
 * line must never become a command.
 */
export function skillMentions(
  text: string,
  known: Iterable<string> | ReadonlySet<string>
): SkillMention[] {
  const catalog = names(known)
  const found: SkillMention[] = []
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const name = match[2]
    if (!catalog.has(name)) continue
    const start = (match.index ?? 0) + (match[1]?.length ?? 0)
    found.push({ name, start, end: start + name.length + 1 })
  }
  return found
}

/**
 * Turns the `$name` mentions a prompt carries into the invocation the harness
 * behind `provider` actually understands. Returns the prompt unchanged for a
 * harness that has no such form, and for a prompt that names nothing.
 *
 * - **claude-code.** The CLI's only user-side invocation is a text block whose
 *   *first* character is `/`: it expands `/name` into the skill's body and
 *   hands it everything after the name as `ARGUMENTS`. A `/name` on a later
 *   line, or after so much as a space, is literal text. So the first mention
 *   is hoisted to the head of the prompt and the rest of what the user wrote
 *   follows it as the arguments. Only one skill expands per message
 *   (anthropics/claude-code#87113), so the remaining mentions are rewritten in
 *   place to `/name` — the model reads those and starts them through its own
 *   Skill tool.
 * - **cursor.** Its agent skills are invoked with `/name` from anywhere in the
 *   message, so every mention is rewritten where it stands.
 */
export function dispatchSkillMentions(
  text: string,
  provider: string,
  known: Iterable<string> | ReadonlySet<string>
): string {
  const catalog = names(known)
  if (catalog.size === 0) return text
  if (provider !== "claude-code" && provider !== "cursor") return text

  const inPlace = text.replace(
    SKILL_TOKEN_REGEX,
    (match, prefix: string, name: string) =>
      catalog.has(name) ? `${prefix}/${name}` : match
  )
  if (provider === "cursor") return inPlace

  const first = skillMentions(text, catalog)[0]
  if (!first) return text
  // The rewritten prompt is the same length as the original — `$` for `/`,
  // one character each — so the mention's offsets still address it.
  const head = inPlace.slice(0, first.start).trim()
  const tail = inPlace.slice(first.end).trim()
  const rest = [head, tail].filter(Boolean).join(" ")
  return rest ? `/${first.name} ${rest}` : `/${first.name}`
}

/* -------------------------------------------------------------------------- */
/* Front matter                                                               */
/* -------------------------------------------------------------------------- */

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

export type SkillFrontmatter = {
  name?: string
  description?: string
  argHint?: string
  userInvocable?: boolean
  userInvocationOnly?: boolean
}

/**
 * The YAML 1.1 boolean spellings the harnesses accept. A skill carrying
 * `user-invocable: no` is absent from the CLI's own commands, so reading only
 * `false` here would offer a command it refuses.
 */
function frontmatterBoolean(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
    case "1":
      return true
    case "false":
    case "no":
    case "off":
    case "n":
    case "0":
      return false
    default:
      return undefined
  }
}

function scalar(value: string): string {
  const trimmed = value.trim()
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  return (quoted && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed).trim()
}

/**
 * The handful of front-matter keys a picker needs, read without a YAML
 * parser: these files are `key: value` at the top level, and anything richer
 * (a block scalar, a nested map) is not something a menu row can show anyway.
 * Returns null when the file has no front matter at all — for a skill that
 * means the harness will not load it either.
 */
export function parseSkillFrontmatter(contents: string): SkillFrontmatter | null {
  const match = FRONTMATTER_PATTERN.exec(contents)
  if (!match) return null

  const front: SkillFrontmatter = {}
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    // Only top-level keys: an indented line belongs to a value this ignores.
    if (/^\s/.test(line)) continue
    const separator = line.indexOf(":")
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = scalar(line.slice(separator + 1))
    if (!value) continue
    switch (key) {
      case "name":
        front.name = value
        break
      case "description":
        front.description = value
        break
      case "argument-hint":
        front.argHint = value
        break
      case "user-invocable":
        if (frontmatterBoolean(value) === false) front.userInvocable = false
        break
      case "disable-model-invocation":
        if (frontmatterBoolean(value) === true) front.userInvocationOnly = true
        break
    }
  }
  return front
}
