import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildTemporaryWorktreeBranchName,
  buildTimestampWorktreeBranchName,
  isTemporaryWorktreeBranch,
  normalizeGitRemoteUrl,
  resolveAutoFeatureBranchName,
  resolveAvailableBranchName,
  sanitizeBranchFragment,
  sanitizeFeatureBranchName,
} from "@/lib/git-naming"

/**
 * The names a worktree gets. Every claim here is really a claim about `git
 * check-ref-format`: a chat title is arbitrary text, and the only reason it can
 * become a branch name without escaping is that these helpers reduce it to an
 * alphabet where git's rules cannot be broken.
 */

test("a title becomes a lowercase, dash-separated fragment", () => {
  assert.equal(sanitizeBranchFragment("Fix the Parser"), "fix-the-parser")
  assert.equal(sanitizeBranchFragment("  spaced  out  "), "spaced-out")
  // Non-ASCII is dashed out rather than transliterated — `ü` is not `u`, and
  // guessing which letter it "meant" is not this module's job.
  assert.equal(sanitizeBranchFragment("Ünïcode ✨ title"), "n-code-title")
})

test("the characters git refuses in a ref never survive", () => {
  // Every one of these is a rule in `git check-ref-format`.
  for (const raw of [
    "a..b",
    "head@{0}",
    "-leading-dash",
    "trailing.lock",
    "spaced name",
    "back\\slash",
    "tilde~one",
    "caret^two",
    "colon:three",
    "question?mark",
    "star*",
    "bracket[1]",
    "double//slash",
    "trailing/",
  ]) {
    const fragment = sanitizeBranchFragment(raw)
    assert.match(fragment, /^[a-z0-9][a-z0-9/_-]*$/, `${raw} → ${fragment}`)
    assert.doesNotMatch(fragment, /\.\.|@\{|\/\/|\.lock$|[/_-]$/, `${raw} → ${fragment}`)
  }
})

test("a title with nothing usable in it still names something", () => {
  assert.equal(sanitizeBranchFragment("???"), "update")
  assert.equal(sanitizeBranchFragment(""), "update")
})

test("a long title is capped rather than truncated mid-dash", () => {
  const fragment = sanitizeBranchFragment("word ".repeat(50))
  assert.ok(fragment.length <= 64)
  assert.doesNotMatch(fragment, /-$/)
})

test("a feature branch keeps a namespace the user already chose", () => {
  assert.equal(sanitizeFeatureBranchName("fix parser"), "feature/fix-parser")
  assert.equal(sanitizeFeatureBranchName("feature/fix"), "feature/fix")
  assert.equal(sanitizeFeatureBranchName("chore/deps"), "feature/chore/deps")
})

test("the auto name comes from the title, and from the clock when there is none", () => {
  assert.equal(resolveAutoFeatureBranchName("Rewrite the sidebar"), "feature/rewrite-the-sidebar")
  // Every chat starts life called "New chat": naming a branch after that would
  // collide with the last one instead of describing this one.
  for (const placeholder of ["", "   ", "New chat", "untitled", "???"]) {
    const name = resolveAutoFeatureBranchName(placeholder)
    assert.ok(isTemporaryWorktreeBranch(name), `${placeholder} → ${name}`)
  }
})

test("a temporary branch is recognizable as one the app invented", () => {
  const random = buildTemporaryWorktreeBranchName(() => "DEADBEEF")
  assert.equal(random, "agent-ui/deadbeef")
  assert.ok(isTemporaryWorktreeBranch(random))
  // A UUID-shaped source is normalized to the canonical eight characters.
  assert.equal(
    buildTemporaryWorktreeBranchName(() => "0f9c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f"),
    "agent-ui/0f9c1d2e"
  )
  const stamped = buildTimestampWorktreeBranchName(new Date(2026, 8, 7, 14, 3, 9))
  assert.equal(stamped, "agent-ui/20260907-140309")
  assert.ok(isTemporaryWorktreeBranch(stamped))
  assert.ok(!isTemporaryWorktreeBranch("feature/real-work"))
  assert.ok(!isTemporaryWorktreeBranch("agent-ui/named-by-hand"))
})

test("a taken name grows a suffix, and the comparison ignores case", () => {
  assert.equal(resolveAvailableBranchName("feature/x", []), "feature/x")
  assert.equal(resolveAvailableBranchName("feature/x", ["feature/x"]), "feature/x-2")
  assert.equal(
    resolveAvailableBranchName("feature/x", ["feature/x", "feature/x-2"]),
    "feature/x-3"
  )
  // macOS and Windows hold `refs/heads/Feature/X` in the same file as the
  // lowercase one, so a case-only difference is not an available name.
  assert.equal(resolveAvailableBranchName("feature/x", ["Feature/X"]), "feature/x-2")
})

test("a hundred collisions still resolve to a usable name", () => {
  const taken = ["feature/x", ...Array.from({ length: 99 }, (_, i) => `feature/x-${i + 2}`)]
  const resolved = resolveAvailableBranchName("feature/x", taken)
  assert.ok(!taken.includes(resolved))
  assert.match(resolved, /^feature\/x-/)
})

test("remote URLs of every shape reduce to one comparison key", () => {
  const expected = "github.com/miskibin/agent-ui"
  for (const url of [
    "https://github.com/miskibin/agent-ui.git",
    "https://github.com/miskibin/agent-ui/",
    "ssh://git@github.com/miskibin/agent-ui.git",
    "git://github.com/miskibin/agent-ui",
    // The scp-style form is not a URL at all — it is the one that needs its
    // own pass, and the one a `.git/config` most often holds.
    "git@github.com:miskibin/agent-ui.git",
    "GIT@GitHub.com:miskibin/Agent-UI",
  ]) {
    assert.equal(normalizeGitRemoteUrl(url), expected, url)
  }
  assert.equal(normalizeGitRemoteUrl("not a url"), "not a url")
})
