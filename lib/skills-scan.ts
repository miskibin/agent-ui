// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
import "server-only"

import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { claudeConfigDir } from "@/lib/import/claude-history"
import {
  parseSkillFrontmatter,
  type DiscoveredCommand,
  type DiscoveredSkill,
  type SkillCatalog,
  type SkillScope,
} from "@/lib/skills"

/**
 * What this machine can run, read off the disk.
 *
 * The harnesses publish skills and their own slash commands as files, not over
 * their protocols: Claude Code's init line names its commands but not where
 * they live, and Cursor's ACP catalog only exists once a session is open — so
 * a composer that waited for either would have an empty `$` menu until the
 * user had already sent something. Scanning the same directories the CLIs do
 * is both cheaper and available before the first turn.
 *
 * Discovery is best-effort throughout: an unreadable root, a malformed file
 * or a name that resolves to nothing is skipped, never raised. A broken skill
 * must not cost the user their menu.
 */

/** Long enough that a menu is instant, short enough that a new skill shows up. */
const CACHE_TTL_MS = 30_000
/** A picker, not an index: past this nobody is scrolling anyway. */
const MAX_ENTRIES = 500
/** A `SKILL.md` is a page of prose. Anything this large is not one. */
const MAX_FILE_BYTES = 64 * 1024
/** Skills nest (`skills/team/review/SKILL.md`); they do not nest deeply. */
const MAX_DEPTH = 4
/** The whole scan's budget, so a root full of junk cannot walk forever. */
const MAX_VISITED_DIRS = 400

type Root = { directory: string; scope: SkillScope }

/**
 * Where each harness keeps them. Claude Code reads `<config dir>/skills` and
 * `<cwd>/.claude/skills`; Cursor reads its own `.cursor/skills` and the shared
 * `.agents/skills` beside it, at both scopes. A skill that lives only in a
 * directory no harness reads is not offered, however tempting the guess.
 */
function skillRoots(cwd: string | undefined, home: string): Root[] {
  const below = (base: string, scope: SkillScope): Root[] => [
    { directory: join(base, ".claude", "skills"), scope },
    { directory: join(base, ".cursor", "skills"), scope },
    { directory: join(base, ".agents", "skills"), scope },
  ]
  return [
    ...(cwd ? below(cwd, "project") : []),
    { directory: join(claudeConfigDir(), "skills"), scope: "user" },
    ...below(home, "user"),
  ]
}

function commandRoots(cwd: string | undefined): Root[] {
  return [
    ...(cwd
      ? [{ directory: join(cwd, ".claude", "commands"), scope: "project" as const }]
      : []),
    { directory: join(claudeConfigDir(), "commands"), scope: "user" as const },
  ]
}

type Budget = { visited: number }

async function readSmallFile(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

async function subdirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

async function markdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * One skill directory. The name is the *directory's*, never the front
 * matter's: the harnesses resolve `/name` and their own overrides by the
 * folder, so a `SKILL.md` declaring something else would have us offer a
 * command that does not exist. That declared name is kept as the label.
 */
function skillFrom(
  directory: string,
  path: string,
  contents: string,
  scope: SkillScope
): DiscoveredSkill | null {
  const front = parseSkillFrontmatter(contents)
  // No front matter means the harness will not load it either.
  if (!front) return null
  const name = directory.trim()
  if (!name) return null
  return {
    name,
    scope,
    path,
    ...(front.name && front.name !== name ? { displayName: front.name } : {}),
    ...(front.description ? { description: front.description } : {}),
    ...(front.userInvocable === false ? { userInvocable: false } : {}),
    ...(front.userInvocationOnly ? { userInvocationOnly: true } : {}),
  }
}

async function collectSkills(
  root: Root,
  found: Map<string, DiscoveredSkill>,
  budget: Budget
): Promise<void> {
  const walk = async (directory: string, depth: number): Promise<void> => {
    for (const entry of await subdirectories(directory)) {
      if (budget.visited >= MAX_VISITED_DIRS || found.size >= MAX_ENTRIES) return
      budget.visited += 1
      const child = join(directory, entry)
      const path = join(child, "SKILL.md")
      const contents = await readSmallFile(path)
      if (contents !== undefined) {
        const skill = skillFrom(entry, path, contents, root.scope)
        // The nearer scope wins: a project skill of a name the user also has
        // is the one this workspace means.
        if (skill && !found.has(skill.name)) found.set(skill.name, skill)
        continue
      }
      if (depth + 1 < MAX_DEPTH) await walk(child, depth + 1)
    }
  }
  await walk(root.directory, 0)
}

async function collectCommands(
  root: Root,
  found: Map<string, DiscoveredCommand>,
  budget: Budget
): Promise<void> {
  const walk = async (directory: string, depth: number): Promise<void> => {
    for (const file of await markdownFiles(directory)) {
      if (found.size >= MAX_ENTRIES) return
      const path = join(directory, file)
      const contents = await readSmallFile(path)
      if (contents === undefined) continue
      const name = file.slice(0, -3).trim()
      if (!name || found.has(name)) continue
      // A command file needs no front matter — the body is the prompt.
      const front = parseSkillFrontmatter(contents)
      found.set(name, {
        name,
        scope: root.scope,
        path,
        ...(front?.description ? { description: front.description } : {}),
        ...(front?.argHint ? { argHint: front.argHint } : {}),
      })
    }
    if (depth + 1 >= MAX_DEPTH) return
    for (const entry of await subdirectories(directory)) {
      if (budget.visited >= MAX_VISITED_DIRS || found.size >= MAX_ENTRIES) return
      budget.visited += 1
      await walk(join(directory, entry), depth + 1)
    }
  }
  await walk(root.directory, 0)
}

const byName = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name)

async function scan(cwd: string | undefined): Promise<SkillCatalog> {
  const budget: Budget = { visited: 0 }
  const home = homedir()
  const skills = new Map<string, DiscoveredSkill>()
  for (const root of skillRoots(cwd, home)) await collectSkills(root, skills, budget)
  const commands = new Map<string, DiscoveredCommand>()
  for (const root of commandRoots(cwd)) await collectCommands(root, commands, budget)
  return {
    skills: [...skills.values()].sort(byName),
    commands: [...commands.values()].sort(byName),
  }
}

type Entry = { at: number; catalog: Promise<SkillCatalog> }

const cache = new Map<string, Entry>()

function keyFor(cwd: string | undefined) {
  return cwd ? resolve(cwd) : ""
}

/**
 * The skills and provider commands available in `cwd`, cached per folder for
 * {@link CACHE_TTL_MS}. The promise itself is cached, so a composer opening
 * two menus at once walks the disk once.
 */
export function scanSkills(cwd?: string): Promise<SkillCatalog> {
  const key = keyFor(cwd)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.catalog
  const catalog = scan(key || undefined).catch(() => {
    // A failed scan must not be the answer for the next 30 seconds.
    cache.delete(key)
    return { skills: [], commands: [] } satisfies SkillCatalog
  })
  cache.set(key, { at: Date.now(), catalog })
  // A handful of folders is all a session touches; anything older is stale.
  if (cache.size > 8) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest && oldest[0] !== key) cache.delete(oldest[0])
  }
  return catalog
}

/** Drops the cached answer for one folder — after a skill is written, say. */
export function invalidateSkills(cwd?: string): void {
  cache.delete(keyFor(cwd))
}
