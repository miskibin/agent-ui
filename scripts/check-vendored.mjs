#!/usr/bin/env node
/**
 * Fails if a vendored file has drifted from miskibin/chat-components.
 *
 *   node scripts/check-vendored.mjs [--repo ../chat-components]
 *
 * The rule this enforces is in CLAUDE.md: `components/ui/**` and the shared
 * `lib/` modules are copies, not forks. Drift is not a style problem — it is
 * how a fix lands in one repo and silently misses the other, and how the next
 * `cp` from upstream quietly deletes a feature nobody remembers adding here.
 *
 * A missing checkout is not a failure: CI has one repo, and this is a check
 * you run beside a sibling clone (or with CHAT_COMPONENTS_DIR set).
 */

import { readFile } from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function upstreamDir() {
  const flag = process.argv.indexOf("--repo")
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1]
  return process.env.CHAT_COMPONENTS_DIR ?? join(ROOT, "..", "chat-components")
}

/**
 * Stock shadcn/ui primitives this app installed straight from shadcn — the
 * registry does not ship them, so they have no upstream to match. Anything
 * else appearing in `components/ui` without an upstream twin is a fork, and
 * that is exactly what this script is here to catch.
 */
const LOCAL_SHADCN = new Set([
  "badge.tsx",
  "card.tsx",
  "input.tsx",
  "label.tsx",
  "select.tsx",
  "skeleton.tsx",
  "slider.tsx",
  "switch.tsx",
])

/** Shared modules outside `components/ui`, listed in CLAUDE.md. */
const SHARED_FILES = [
  "hooks/use-click-outside.ts",
  "lib/agent-runtime.ts",
  "lib/cursor-agent-types.ts",
  "lib/cursor-agent.ts",
  "lib/cursor-stream.ts",
  "lib/layout-transition.ts",
  "lib/mock-agent.ts",
]

const upstream = upstreamDir()
if (!existsSync(upstream)) {
  console.log(
    `chat-components checkout not found at ${relative(ROOT, upstream)} — skipping.\n` +
      "Clone it beside this repo, or pass --repo <path>, to check for drift."
  )
  process.exit(0)
}

const drifted = []
const forked = []
const missing = []

async function compare(rel) {
  const here = join(ROOT, rel)
  const there = join(upstream, rel)
  if (!existsSync(there)) {
    forked.push(rel)
    return
  }
  if (!existsSync(here)) {
    missing.push(rel)
    return
  }
  const [a, b] = await Promise.all([readFile(here), readFile(there)])
  if (!a.equals(b)) drifted.push(rel)
}

for (const name of readdirSync(join(ROOT, "components/ui"))) {
  if (LOCAL_SHADCN.has(name)) continue
  await compare(`components/ui/${name}`)
}
for (const rel of SHARED_FILES) await compare(rel)

// A file upstream ships that this app never installed is fine — the registry
// is larger than any one consumer. The reverse is not.
for (const rel of drifted) console.error(`drift:  ${rel}`)
for (const rel of forked) console.error(`forked: ${rel} (no upstream twin)`)
for (const rel of missing) console.error(`gone:   ${rel} (upstream has it)`)

if (drifted.length || forked.length || missing.length) {
  console.error(
    `\n${drifted.length + forked.length + missing.length} vendored file(s) do ` +
      "not match miskibin/chat-components.\n" +
      "Fix it THERE first, then copy back — never the other way round.\n" +
      "See the top of CLAUDE.md."
  )
  process.exit(1)
}

console.log("vendored files match chat-components.")
