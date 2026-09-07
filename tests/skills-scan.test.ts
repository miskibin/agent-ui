import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { invalidateSkills, scanSkills } from "@/lib/skills-scan"

/**
 * Discovery reads what the harnesses read, so the menu can be right before the
 * first turn. The rules worth pinning are the ones a wrong answer hides: which
 * copy of a name wins, what a broken file costs, and that the identity is the
 * directory rather than whatever the front matter calls itself.
 */

let home = ""
let project = ""
const env = { home: process.env.HOME, config: process.env.CLAUDE_CONFIG_DIR }

function skill(root: string, name: string, front: string[]) {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(
    join(root, name, "SKILL.md"),
    `---\n${front.join("\n")}\n---\n\nBody of ${name}.\n`
  )
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "agent-ui-skills-home-"))
  project = mkdtempSync(join(tmpdir(), "agent-ui-skills-project-"))
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude")

  const userSkills = join(home, ".claude", "skills")
  skill(userSkills, "commit", ["description: Write the commit message"])
  skill(userSkills, "review", ["description: The personal one"])
  skill(userSkills, "indexer", [
    "description: Rebuild the index",
    "user-invocable: false",
  ])
  // Cursor's own root, at the user scope.
  skill(join(home, ".cursor", "skills"), "explain", ["description: Explain it"])

  const projectSkills = join(project, ".claude", "skills")
  skill(projectSkills, "review", ["description: The project one"])
  skill(projectSkills, "release", [
    "name: Cut a release",
    "description: Tag and publish",
    "disable-model-invocation: true",
  ])
  // Nested one level: a skill library kept in a subdirectory.
  skill(join(projectSkills, "team"), "triage", ["description: Sort the inbox"])
  // No front matter — the harness would not load it either.
  mkdirSync(join(projectSkills, "broken"), { recursive: true })
  writeFileSync(join(projectSkills, "broken", "SKILL.md"), "# no front matter\n")
  // Over the size cap.
  skill(projectSkills, "huge", ["description: x".padEnd(70_000, "y")])

  const commands = join(project, ".claude", "commands")
  mkdirSync(commands, { recursive: true })
  writeFileSync(
    join(commands, "deploy.md"),
    "---\ndescription: Ship it\nargument-hint: <env>\n---\n\nDeploy $ARGUMENTS.\n"
  )
  // A command file needs no front matter at all.
  writeFileSync(join(commands, "standup.md"), "Summarize yesterday.\n")
  mkdirSync(join(home, ".claude", "commands"), { recursive: true })
  writeFileSync(
    join(home, ".claude", "commands", "deploy.md"),
    "---\ndescription: The personal one\n---\n"
  )
})

after(() => {
  process.env.HOME = env.home
  if (env.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = env.config
  for (const dir of [home, project]) rmSync(dir, { recursive: true, force: true })
})

test("both scopes are read, and the project's copy of a name wins", async () => {
  invalidateSkills(project)
  const { skills } = await scanSkills(project)
  const names = skills.map((entry) => entry.name)
  assert.deepEqual(names, [
    "commit",
    "explain",
    "indexer",
    "release",
    "review",
    "triage",
  ])
  const review = skills.find((entry) => entry.name === "review")
  assert.equal(review?.scope, "project")
  assert.equal(review?.description, "The project one")
  assert.equal(skills.find((entry) => entry.name === "commit")?.scope, "user")
  // Cursor keeps its skills in a root of its own, at both scopes.
  assert.equal(skills.find((entry) => entry.name === "explain")?.scope, "user")
})

test("the directory is the identity; a declared name is only a label", async () => {
  const { skills } = await scanSkills(project)
  const release = skills.find((entry) => entry.name === "release")
  // `/release` is what the harness resolves — never `/Cut a release`.
  assert.equal(release?.displayName, "Cut a release")
  assert.equal(release?.userInvocationOnly, true)
  assert.equal(release?.userInvocable, undefined)
  assert.equal(
    skills.find((entry) => entry.name === "indexer")?.userInvocable,
    false
  )
})

test("a skill without front matter, or too large to be prose, is skipped", async () => {
  const { skills } = await scanSkills(project)
  const names = skills.map((entry) => entry.name)
  assert.ok(!names.includes("broken"))
  assert.ok(!names.includes("huge"))
})

test("commands come with their hint, and the project's win too", async () => {
  const { commands } = await scanSkills(project)
  assert.deepEqual(
    commands.map((entry) => entry.name),
    ["deploy", "standup"]
  )
  const deploy = commands.find((entry) => entry.name === "deploy")
  assert.equal(deploy?.scope, "project")
  assert.equal(deploy?.description, "Ship it")
  assert.equal(deploy?.argHint, "<env>")
  // No front matter is fine for a command: the body is the prompt.
  assert.equal(commands.find((entry) => entry.name === "standup")?.description, undefined)
})

test("without a folder only the user's own are offered", async () => {
  invalidateSkills()
  const { skills, commands } = await scanSkills()
  assert.deepEqual(
    skills.map((entry) => entry.name),
    ["commit", "explain", "indexer", "review"]
  )
  assert.equal(skills.find((entry) => entry.name === "review")?.scope, "user")
  assert.deepEqual(
    commands.map((entry) => entry.name),
    ["deploy"]
  )
})
