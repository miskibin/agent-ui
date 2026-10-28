import assert from "node:assert/strict"
import { test } from "node:test"

import { APPEARANCE_BOOTSTRAP_SCRIPT } from "@/lib/theme/apply"
import { contrastFixes, parseOklch, tunedVars } from "@/lib/theme/contrast"
import {
  RETIRED_THEMES,
  THEME_PRESETS,
  findPreset,
} from "@/lib/theme/presets"

const SHIPPED = ["modern-minimal", "claude", "ink", "grove", "dusk"]
const AUTHORED = ["ink", "grove", "dusk"]

test("the shipped set is the five themes that hold up", () => {
  assert.deepEqual(
    THEME_PRESETS.map((preset) => preset.id),
    SHIPPED
  )
  assert.equal(findPreset(undefined).id, "modern-minimal")
  assert.equal(findPreset("soft-pop").id, "modern-minimal")
  assert.equal(findPreset("claude").id, "claude")
})

test("retired catalog ids land on the closest replacement", () => {
  for (const [from, to] of Object.entries(RETIRED_THEMES)) {
    assert.equal(findPreset(from).id, to, from)
    assert.ok(
      APPEARANCE_BOOTSTRAP_SCRIPT.includes(`"${from}":"${to}"`),
      `pre-paint guard drops ${from}`
    )
  }
})

test("authored themes already clear standard contrast", () => {
  const untouched = [
    "foreground",
    "muted-foreground",
    "primary-foreground",
    "border",
    "sidebar-border",
  ]
  for (const id of AUTHORED) {
    const preset = findPreset(id)
    for (const scheme of ["light", "dark"] as const) {
      const raw = { ...preset.cssVars.theme, ...preset.cssVars[scheme] }
      const fixes = contrastFixes(tunedVars(raw, scheme), "standard")
      for (const token of untouched) {
        assert.equal(
          fixes[token],
          undefined,
          `${id}/${scheme}: standard contrast rewrote ${token} — the palette should already clear the bar`
        )
      }
      const foreground = parseOklch(raw.foreground)
      const background = parseOklch(raw.background)
      assert.ok(foreground && foreground.c <= 0.03, `${id}/${scheme} body text is stained`)
      assert.ok(background && background.c <= 0.025, `${id}/${scheme} surface is stained`)
      assert.equal(raw["tracking-normal"], "0em")
      assert.equal(raw["letter-spacing"], "0em")
    }
  }
})
