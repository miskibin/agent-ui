import assert from "node:assert/strict"
import { test } from "node:test"

import {
  estimateCost,
  priceForModel,
  priceSource,
  type ModelPriceOverrides,
} from "@/lib/model-pricing"
import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/settings/schema"
import {
  isBlankPriceForm,
  parsePriceForm,
  priceForm,
  type PriceForm,
} from "@/app/settings/usage-price-form"

/**
 * The user's own price table: that it outranks the built-in one, that it can
 * make an unknown model priced and a known one free, and that the editor in
 * front of it refuses everything that is not a price.
 *
 * The distinction under test throughout is the one the whole usage feature
 * rests on — *free* is a price, *unknown* is the absence of one.
 */

const NONE: ModelPriceOverrides = {}

/* -------------------------------------------------------------------------- */
/* Precedence                                                                  */
/* -------------------------------------------------------------------------- */

test("no overrides leaves every built-in answer exactly as it was", () => {
  assert.deepEqual(
    priceForModel("openai/gpt-4o", "chat", NONE),
    priceForModel("openai/gpt-4o", "chat")
  )
  assert.equal(priceForModel("ollama/qwen3:8b", "ollama", NONE)?.input, 0)
  assert.equal(priceForModel("cursor-small", "cursor", NONE), null)
})

test("an override outranks the built-in table", () => {
  const overrides: ModelPriceOverrides = {
    "openai/gpt-4o": { input: 1, output: 2 },
  }
  assert.deepEqual(priceForModel("openai/gpt-4o", "chat", overrides), {
    input: 1,
    output: 2,
  })
  // One million input tokens at the overridden rate, not the list one.
  assert.equal(estimateCost("openai/gpt-4o", 1_000_000, 0, "chat", undefined, overrides), 1)
})

test("an override prices a model the tables have never heard of", () => {
  const overrides: ModelPriceOverrides = { "cursor-small": { input: 3, output: 6 } }
  assert.equal(priceForModel("cursor-small", "cursor"), null)
  assert.equal(priceSource("cursor-small", "cursor", overrides), "override")
  assert.equal(
    estimateCost("cursor-small", 1_000_000, 1_000_000, "cursor", undefined, overrides),
    9
  )
})

test("0/0 is free, and free is not unknown", () => {
  const overrides: ModelPriceOverrides = { sonnet: { input: 0, output: 0 } }
  const cost = estimateCost("sonnet", 5_000_000, 1_000_000, "claudeCode", undefined, overrides)
  assert.equal(cost, 0)
  assert.notEqual(cost, null)
  // Without it, the same id is priced at Anthropic's rates.
  assert.ok((estimateCost("sonnet", 5_000_000, 1_000_000, "claudeCode") ?? 0) > 0)
})

test("an unpriced model stays unpriced — an empty table prices nothing", () => {
  assert.equal(priceForModel("mystery/model-x", "chat", NONE), null)
  assert.equal(estimateCost("mystery/model-x", 1_000, 1_000, "chat", undefined, NONE), null)
  assert.equal(priceSource("mystery/model-x", "chat", NONE), "unpriced")
})

test("an override matches the whole id, never a prefix of it", () => {
  const overrides: ModelPriceOverrides = { "openai/gpt-5": { input: 99, output: 99 } }
  assert.equal(priceForModel("openai/gpt-5", "chat", overrides)?.input, 99)
  // `gpt-5-nano` is its own model and keeps its own list price.
  assert.equal(
    priceForModel("openai/gpt-5-nano", "chat", overrides)?.input,
    priceForModel("openai/gpt-5-nano", "chat")?.input
  )
})

test("cache rates fall back to the input rate's ratios when left out", () => {
  const overrides: ModelPriceOverrides = { "x/y": { input: 10, output: 0 } }
  // A million cache reads at a tenth of $10.
  assert.equal(
    estimateCost("x/y", 0, 0, "chat", { cachedInputTokens: 1_000_000 }, overrides),
    1
  )
  const explicit: ModelPriceOverrides = {
    "x/y": { input: 10, output: 0, cacheRead: 0 },
  }
  assert.equal(
    estimateCost("x/y", 0, 0, "chat", { cachedInputTokens: 1_000_000 }, explicit),
    0
  )
})

test("priceSource names where a number came from", () => {
  assert.equal(priceSource("openai/gpt-4o", "chat"), "builtin")
  assert.equal(priceSource("ollama/qwen3:8b", "ollama"), "builtin")
  assert.equal(priceSource("cursor-small", "cursor"), "unpriced")
  assert.equal(
    priceSource("openai/gpt-4o", "chat", { "openai/gpt-4o": { input: 1, output: 1 } }),
    "override"
  )
})

/* -------------------------------------------------------------------------- */
/* The settings record                                                         */
/* -------------------------------------------------------------------------- */

test("price overrides default to nothing and survive a round trip", () => {
  assert.deepEqual(DEFAULT_SETTINGS.usage.priceOverrides, {})
  const stored = {
    usage: {
      priceOverrides: {
        "openai/gpt-4o": { input: 2.5, output: 10, cacheRead: 0.25 },
      },
    },
  }
  assert.deepEqual(normalizeSettings(stored).usage.priceOverrides, {
    "openai/gpt-4o": { input: 2.5, output: 10, cacheRead: 0.25 },
  })
})

test("a half-written or hostile entry is dropped, not half-applied", () => {
  const settings = normalizeSettings({
    usage: {
      priceOverrides: {
        "only-input": { input: 1 },
        negative: { input: -1, output: 1 },
        wordy: { input: "1", output: "2" },
        "not-finite": { input: Number.POSITIVE_INFINITY, output: 1 },
        "   ": { input: 1, output: 1 },
        good: { input: 0, output: 0 },
      },
    },
  })
  assert.deepEqual(Object.keys(settings.usage.priceOverrides), ["good"])
  assert.deepEqual(settings.usage.priceOverrides.good, { input: 0, output: 0 })
})

test("a settings file written before prices existed still loads", () => {
  const settings = normalizeSettings({ chat: { autoTitle: false } })
  assert.deepEqual(settings.usage, DEFAULT_SETTINGS.usage)
  assert.equal(settings.chat.autoTitle, false)
  assert.equal(
    settings.chat.newWorktreesStartFromOrigin,
    DEFAULT_SETTINGS.chat.newWorktreesStartFromOrigin
  )
  assert.equal(
    settings.chat.autoSettleAfterDays,
    DEFAULT_SETTINGS.chat.autoSettleAfterDays
  )
})

test("the two chat flags are clamped rather than trusted", () => {
  assert.equal(
    normalizeSettings({ chat: { newWorktreesStartFromOrigin: false } }).chat
      .newWorktreesStartFromOrigin,
    false
  )
  assert.equal(
    normalizeSettings({ chat: { newWorktreesStartFromOrigin: "yes" } }).chat
      .newWorktreesStartFromOrigin,
    true
  )
  assert.equal(normalizeSettings({ chat: { autoSettleAfterDays: 0 } }).chat.autoSettleAfterDays, 0)
  assert.equal(normalizeSettings({ chat: { autoSettleAfterDays: -5 } }).chat.autoSettleAfterDays, 0)
  assert.equal(
    normalizeSettings({ chat: { autoSettleAfterDays: 7.6 } }).chat.autoSettleAfterDays,
    8
  )
  assert.equal(
    normalizeSettings({ chat: { autoSettleAfterDays: 10_000 } }).chat.autoSettleAfterDays,
    365
  )
  assert.equal(
    normalizeSettings({ chat: { autoSettleAfterDays: "soon" } }).chat.autoSettleAfterDays,
    DEFAULT_SETTINGS.chat.autoSettleAfterDays
  )
})

/* -------------------------------------------------------------------------- */
/* The editor's form                                                           */
/* -------------------------------------------------------------------------- */

function form(values: Partial<PriceForm> = {}): PriceForm {
  return { input: "", output: "", cacheRead: "", cacheWrite: "", ...values }
}

test("an empty form is a removal, not an error", () => {
  assert.ok(isBlankPriceForm(form()))
  assert.deepEqual(parsePriceForm(form()), { status: "empty" })
  assert.deepEqual(parsePriceForm(form({ input: "  ", output: "" })), {
    status: "empty",
  })
})

test("input and output are needed together", () => {
  const result = parsePriceForm(form({ input: "2" }))
  assert.equal(result.status, "error")
  const other = parsePriceForm(form({ output: "2" }))
  assert.equal(other.status, "error")
})

test("a price is non-negative and at most six decimals", () => {
  assert.equal(parsePriceForm(form({ input: "-1", output: "2" })).status, "error")
  assert.equal(parsePriceForm(form({ input: "1e-6", output: "2" })).status, "error")
  assert.equal(parsePriceForm(form({ input: "1.2345678", output: "2" })).status, "error")
  assert.equal(parsePriceForm(form({ input: "abc", output: "2" })).status, "error")
  assert.equal(parsePriceForm(form({ input: "0.000001", output: "2" })).status, "ok")
  assert.equal(parsePriceForm(form({ input: ".5", output: "2" })).status, "ok")
  assert.equal(parsePriceForm(form({ input: "0", output: "0" })).status, "ok")
})

test("a blank cache field is left out, an explicit zero is kept", () => {
  const filled = parsePriceForm(form({ input: "1", output: "2" }))
  assert.deepEqual(filled, { status: "ok", price: { input: 1, output: 2 } })
  const zeroed = parsePriceForm(
    form({ input: "1", output: "2", cacheRead: "0" })
  )
  assert.deepEqual(zeroed, {
    status: "ok",
    price: { input: 1, output: 2, cacheRead: 0 },
  })
})

test("a stored price fills the form it came from", () => {
  assert.deepEqual(priceForm({ input: 2.5, output: 10 }), {
    input: "2.5",
    output: "10",
    cacheRead: "",
    cacheWrite: "",
  })
  assert.deepEqual(priceForm(), {
    input: "",
    output: "",
    cacheRead: "",
    cacheWrite: "",
  })
  // Round trip: what the editor shows parses back to what was stored.
  const parsed = parsePriceForm(priceForm({ input: 0, output: 0, cacheWrite: 1.5 }))
  assert.deepEqual(parsed, {
    status: "ok",
    price: { input: 0, output: 0, cacheWrite: 1.5 },
  })
})
