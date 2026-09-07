import assert from "node:assert/strict"
import { test } from "node:test"

import {
  dispatchSkillMentions,
  parseSkillFrontmatter,
  skillMentions,
} from "@/lib/skills"

/**
 * The pure half of skills: what a `$mention` is, and what each harness has to
 * be handed instead of one. Both are load-bearing — a mention the composer
 * chips but a turn does not dispatch is a skill the user thinks they ran.
 */

const KNOWN = ["review", "changelog", "2fa", "code-review"]

test("a mention is a known name after a space or the start", () => {
  assert.deepEqual(
    skillMentions("$review this and then $changelog", KNOWN).map((m) => m.name),
    ["review", "changelog"]
  )
  // Mid-word, and a name nobody discovered, stay prose.
  assert.deepEqual(skillMentions("cost=x$review", KNOWN), [])
  assert.deepEqual(skillMentions("echo $HOME > f", KNOWN), [])
})

test("money is never a mention", () => {
  const money = "it costs $20 or $20k or $100M or $1e6 or $5 or $1_000"
  assert.deepEqual(skillMentions(money, ["20", "20k", "100M", "1e6", "5"]), [])
  // A name may still open with a digit, as long as it carries a letter.
  assert.deepEqual(
    skillMentions("turn on $2fa", KNOWN).map((m) => m.name),
    ["2fa"]
  )
})

test("a mention's offsets address the token in the text", () => {
  const [mention] = skillMentions("run $review now", KNOWN)
  assert.equal("run $review now".slice(mention.start, mention.end), "$review")
})

test("claude-code takes the first mention to the head of the prompt", () => {
  // Its only user-side invocation is a text block opening with `/`.
  assert.equal(
    dispatchSkillMentions("please $review this diff", "claude-code", KNOWN),
    "/review please this diff"
  )
  assert.equal(
    dispatchSkillMentions("$review this diff", "claude-code", KNOWN),
    "/review this diff"
  )
  assert.equal(dispatchSkillMentions("$review", "claude-code", KNOWN), "/review")
})

test("only the first skill is invoked; the rest are named for the agent", () => {
  assert.equal(
    dispatchSkillMentions("$review then $changelog", "claude-code", KNOWN),
    "/review then /changelog"
  )
  assert.equal(
    dispatchSkillMentions("first $changelog then later $review", "claude-code", KNOWN),
    "/changelog first then later /review"
  )
  // A mention has to end on whitespace, so `$changelog,` is prose — and the
  // composer chips exactly the same set, which is why the two agree.
  assert.equal(
    dispatchSkillMentions("first $changelog, then $review", "claude-code", KNOWN),
    "/review first $changelog, then"
  )
})

test("cursor invokes a skill where it stands", () => {
  assert.equal(
    dispatchSkillMentions("please $review this diff", "cursor", KNOWN),
    "please /review this diff"
  )
  assert.equal(
    dispatchSkillMentions("$review and $changelog", "cursor", KNOWN),
    "/review and /changelog"
  )
})

test("nothing is rewritten without a skill to dispatch", () => {
  assert.equal(dispatchSkillMentions("plain text", "claude-code", KNOWN), "plain text")
  // An unknown mention is not a command, whatever it looks like.
  assert.equal(dispatchSkillMentions("$deploy now", "claude-code", KNOWN), "$deploy now")
  // A harness with no invocation form of its own is handed the text as typed.
  assert.equal(dispatchSkillMentions("$review it", "ollama", KNOWN), "$review it")
  assert.equal(dispatchSkillMentions("$review it", "claude-code", []), "$review it")
})

test("front matter carries the four fields a menu needs", () => {
  const front = parseSkillFrontmatter(
    [
      "---",
      "name: Code Review",
      'description: "Review the diff"',
      "argument-hint: <path>",
      "user-invocable: no",
      "disable-model-invocation: yes",
      "# a comment",
      "metadata:",
      "  surfaces: cli",
      "---",
      "",
      "Body text.",
    ].join("\n")
  )
  assert.deepEqual(front, {
    name: "Code Review",
    description: "Review the diff",
    argHint: "<path>",
    userInvocable: false,
    userInvocationOnly: true,
  })
})

test("the permissive booleans are read the way the CLI reads them", () => {
  const parse = (line: string) => parseSkillFrontmatter(`---\n${line}\n---\n`)
  assert.deepEqual(parse("user-invocable: false"), { userInvocable: false })
  assert.deepEqual(parse("user-invocable: off"), { userInvocable: false })
  assert.deepEqual(parse("user-invocable: 0"), { userInvocable: false })
  // Only the negative spelling matters: `true` is the default already.
  assert.deepEqual(parse("user-invocable: true"), {})
  assert.deepEqual(parse("disable-model-invocation: on"), {
    userInvocationOnly: true,
  })
  assert.deepEqual(parse("disable-model-invocation: false"), {})
})

test("a file without front matter parses as nothing", () => {
  assert.equal(parseSkillFrontmatter("# Just a heading\n"), null)
  // Unterminated, and empty, are both "no front matter" — the same reading
  // the harnesses take, which is why such a skill is skipped entirely.
  assert.equal(parseSkillFrontmatter("---\nname: x\n"), null)
  assert.equal(parseSkillFrontmatter("---\n---\n"), null)
  assert.deepEqual(parseSkillFrontmatter("---\nname: x\n---\n"), { name: "x" })
})
