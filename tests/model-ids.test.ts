import assert from "node:assert/strict"
import { test } from "node:test"

import { joinModelId, splitModelId } from "@/lib/model-providers/ids"
import { estimateCost, formatCost, priceForModel } from "@/lib/model-pricing"
import {
  MODEL_PROVIDER_SLUG_RE,
  RESERVED_MODEL_PROVIDER_SLUGS,
} from "@/lib/model-providers/presets"
import { normalizeSettings } from "@/lib/settings/schema"

/**
 * A model is `<source>/<model>`, split on the *first* slash — hosted catalogs
 * hand out ids containing slashes of their own, and one that stops
 * round-tripping picks the wrong provider on the next turn.
 */

test("only the first slash separates source from model", () => {
  assert.deepEqual(splitModelId("openai/gpt-4o"), { source: "openai", model: "gpt-4o" })
  assert.deepEqual(splitModelId("openrouter/openai/gpt-4o"), {
    source: "openrouter",
    model: "openai/gpt-4o",
  })
  assert.deepEqual(splitModelId("ollama/hf.co/user/repo:q4"), {
    source: "ollama",
    model: "hf.co/user/repo:q4",
  })
})

test("a bare id is Ollama's, the way ids were stored before providers existed", () => {
  assert.deepEqual(splitModelId("llama3.1:8b"), { source: "ollama", model: "llama3.1:8b" })
  // Nothing before the slash is not a source either.
  assert.deepEqual(splitModelId("/gpt-4o"), { source: "ollama", model: "/gpt-4o" })
  assert.deepEqual(splitModelId(""), { source: "ollama", model: "" })
})

test("every composite id round-trips", () => {
  for (const id of [
    "openai/gpt-4o",
    "openrouter/openai/gpt-4o",
    "together/meta-llama/Llama-3-70b",
    "ollama/hf.co/user/repo:q4",
  ]) {
    const { source, model } = splitModelId(id)
    assert.equal(joinModelId(source, model), id)
  }
})

test("a slug that would not round-trip never enters settings", () => {
  assert.equal(MODEL_PROVIDER_SLUG_RE.test("my-host"), true)
  assert.equal(MODEL_PROVIDER_SLUG_RE.test("my/host"), false)
  assert.equal(MODEL_PROVIDER_SLUG_RE.test("My-Host"), false)
  assert.equal(MODEL_PROVIDER_SLUG_RE.test(""), false)
  assert.ok(RESERVED_MODEL_PROVIDER_SLUGS.includes("ollama"))

  const settings = normalizeSettings({
    modelProviders: {
      "my-host": { enabled: true, name: "Mine", baseUrl: "https://x/v1", models: [] },
      "bad/slug": { enabled: true, name: "Nope", baseUrl: "https://y/v1" },
      ollama: { enabled: true, name: "Hijack", baseUrl: "https://z/v1" },
    },
  })
  assert.ok(settings.modelProviders["my-host"])
  assert.equal(settings.modelProviders["bad/slug"], undefined)
  // `ollama` names the local server; a stored entry must not claim the prefix.
  assert.equal(settings.modelProviders.ollama, undefined)
})

/**
 * Pricing is an estimate shown beside a turn's tokens. The one rule that is
 * not cosmetic: a local model is free, and a bare id from a CLI harness is
 * *unknown* — reading it as free would print "$0" next to a paid run.
 */

test("Ollama is free, however the id is spelled", () => {
  assert.deepEqual(priceForModel("ollama/llama3.1:8b"), { input: 0, output: 0 })
  assert.deepEqual(priceForModel("llama3.1:8b", "ollama"), { input: 0, output: 0 })
  assert.equal(formatCost(0), "free")
})

test("a bare id from another harness is unknown, not free", () => {
  assert.equal(priceForModel("gpt-5", "cursor"), null)
  assert.equal(priceForModel("composer-2.5", "mock"), null)
  assert.equal(priceForModel(""), null)
  assert.equal(estimateCost("gpt-5", 1000, 1000, "cursor"), null)
})

test("a dated snapshot is priced by its family, longest prefix winning", () => {
  assert.deepEqual(priceForModel("openai/gpt-4o-2024-11-20"), priceForModel("openai/gpt-4o"))
  // `gpt-4o-mini` must not be priced as `gpt-4o`.
  assert.notDeepEqual(priceForModel("openai/gpt-4o-mini"), priceForModel("openai/gpt-4o"))
})

test("an aggregator's vendor-prefixed id finds the upstream price", () => {
  assert.deepEqual(
    priceForModel("openrouter/anthropic/claude-sonnet-4-5"),
    priceForModel("anthropic/claude-sonnet-4-5")
  )
  assert.equal(priceForModel("openrouter/some-vendor/never-heard-of-it"), null)
})

test("cost is per million tokens and formatted by magnitude", () => {
  const price = priceForModel("openai/gpt-4o")
  assert.ok(price)
  assert.equal(
    estimateCost("openai/gpt-4o", 1_000_000, 1_000_000),
    price.input + price.output
  )
  assert.equal(formatCost(0.0042), "$0.0042")
  assert.equal(formatCost(0.42), "$0.420")
  assert.equal(formatCost(1.3), "$1.30")
})
