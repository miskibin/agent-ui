import assert from "node:assert/strict"
import { test } from "node:test"

import type { ModelPriceOverrides } from "@/lib/model-pricing"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"
import { buildUsageReport, chatUsage, repriceUsage } from "@/lib/usage"

/**
 * The aggregation under the user's own prices: a model the app cannot price
 * becomes countable, a model it prices wrongly is corrected, and re-pricing an
 * already-summed chat gives the same answer as summing it again from the
 * transcript — which is what lets the header apply a price without re-walking
 * every message.
 */

const NOW = Date.UTC(2026, 0, 31, 12)

function session(id: string): SessionMeta {
  return {
    id,
    title: id,
    pinned: false,
    order: 0,
    providerId: "mock",
    model: "",
    createdAt: 0,
    updatedAt: 0,
    messageCount: 1,
  }
}

function turn(
  meta: Partial<NonNullable<StoredMessage["metadata"]>>
): StoredMessage {
  return {
    id: `m${Math.random().toString(36).slice(2)}`,
    content: "answer",
    sender: "assistant",
    metadata: { inputTokens: 1_000_000, outputTokens: 0, finishedAt: NOW, ...meta },
  }
}

test("an override makes an unpriced model count", () => {
  const messages = [turn({ model: "cursor-small", providerId: "cursor" })]
  const plain = buildUsageReport([session("a")], { a: messages }, 30, NOW)
  assert.equal(plain.totals.cost, null)
  assert.equal(plain.totals.unpricedTurns, 1)

  const overrides: ModelPriceOverrides = { "cursor-small": { input: 4, output: 8 } }
  const priced = buildUsageReport([session("a")], { a: messages }, 30, NOW, overrides)
  assert.equal(priced.totals.cost, 4)
  assert.equal(priced.totals.pricedTurns, 1)
  assert.equal(priced.totals.unpricedTurns, 0)
  // The tokens were never in question — only what they cost.
  assert.equal(priced.totals.tokens, plain.totals.tokens)
})

test("an override can make a hosted model free without making it unknown", () => {
  const messages = [turn({ model: "openai/gpt-4o", providerId: "chat" })]
  const overrides: ModelPriceOverrides = {
    "openai/gpt-4o": { input: 0, output: 0 },
  }
  const report = buildUsageReport([session("a")], { a: messages }, 30, NOW, overrides)
  assert.equal(report.totals.cost, 0)
  assert.equal(report.totals.pricedTurns, 1)
  assert.equal(report.totals.unpricedTurns, 0)
})

test("a model with no override keeps its list price beside one that has", () => {
  const messages = [
    turn({ model: "openai/gpt-4o", providerId: "chat" }),
    turn({ model: "cursor-small", providerId: "cursor" }),
  ]
  const overrides: ModelPriceOverrides = { "cursor-small": { input: 1, output: 1 } }
  const report = buildUsageReport([session("a")], { a: messages }, 30, NOW, overrides)
  const gpt = report.models.find((row) => row.model === "openai/gpt-4o")
  const cursor = report.models.find((row) => row.model === "cursor-small")
  assert.equal(cursor?.cost, 1)
  // $2.50 per million input on the list.
  assert.equal(gpt?.cost, 2.5)
  assert.equal(report.totals.cost, 3.5)
  assert.equal(report.totals.unpricedTurns, 0)
})

test("re-pricing an aggregate equals aggregating with the prices", () => {
  const messages = [
    turn({
      model: "openai/gpt-4o",
      providerId: "chat",
      inputTokens: 120_000,
      outputTokens: 8_000,
      cachedInputTokens: 40_000,
      cacheCreationTokens: 10_000,
    } as NonNullable<StoredMessage["metadata"]>),
    turn({ model: "cursor-small", providerId: "cursor", outputTokens: 5_000 }),
  ]
  const overrides: ModelPriceOverrides = {
    "cursor-small": { input: 2, output: 4 },
    "openai/gpt-4o": { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1.25 },
  }
  const direct = chatUsage(messages, overrides)
  const repriced = repriceUsage(chatUsage(messages)!, overrides)
  assert.ok(direct)
  assert.equal(repriced.cost, direct.cost)
  assert.equal(repriced.pricedTurns, direct.pricedTurns)
  assert.equal(repriced.unpricedTurns, direct.unpricedTurns)
  assert.equal(repriced.tokens, direct.tokens)
  assert.equal(repriced.cacheTokens, direct.cacheTokens)
  assert.deepEqual(
    repriced.models.map((row) => [row.model, row.cost]),
    direct.models.map((row) => [row.model, row.cost])
  )
})

test("re-pricing with nothing to apply leaves the aggregate as it was", () => {
  const usage = chatUsage([
    turn({ model: "openai/gpt-4o", providerId: "chat" }),
    turn({ model: "cursor-small", providerId: "cursor" }),
  ])
  assert.ok(usage)
  const same = repriceUsage(usage, {})
  assert.equal(same.cost, usage.cost)
  assert.equal(same.unpricedTurns, usage.unpricedTurns)
  assert.equal(same.pricedTurns, usage.pricedTurns)
})
