/**
 * The hand-typed half of Settings → Usage: turning four text fields into one
 * price, or into a clear reason why it is not one yet.
 *
 * Ported from T3 Code (MIT), `apps/web/src/components/usage/usagePriceForm.ts`,
 * and adapted to this app's `ModelPriceOverride` shape: the field names are
 * ours, the decimal places are capped, and a form with every field blank is a
 * *removal* rather than a parse failure — this editor writes into a settings
 * record the user can also empty out, and clearing the boxes is how they say
 * "go back to the built-in price".
 *
 * Pure and free of React so it can be unit tested on its own.
 */

import type { ModelPriceOverride } from "@/lib/settings/schema"

export const PRICE_FIELDS = [
  { key: "input", label: "Input", optional: false },
  { key: "output", label: "Output", optional: false },
  { key: "cacheRead", label: "Cache read", optional: true },
  { key: "cacheWrite", label: "Cache write", optional: true },
] as const

export type PriceField = (typeof PRICE_FIELDS)[number]["key"]

/** One row's boxes, exactly as typed — never a number until it parses. */
export type PriceForm = Record<PriceField, string>

/**
 * Plain decimals only, at most six places. Six is where a price per million
 * tokens stops meaning anything (a millionth of a cent per token), and the
 * cap is what keeps `0.0000001` from being stored as a price that rounds to
 * free everywhere it is shown. Exponents are refused for the same reason: a
 * `1e-9` typed into a money field is far more likely a slip than an intent.
 */
const RATE_RE = /^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/

export const PRICE_HINT = "Dollars per million tokens, up to 6 decimals. 0 means free."

export type PriceFormResult =
  /** Every box empty — the override, if any, should be dropped. */
  | { status: "empty" }
  | { status: "ok"; price: ModelPriceOverride }
  | { status: "error"; message: string; field: PriceField }

/** The form a stored override fills, and the blank one when there is none. */
export function priceForm(price?: ModelPriceOverride): PriceForm {
  return {
    input: rateText(price?.input),
    output: rateText(price?.output),
    cacheRead: rateText(price?.cacheRead),
    cacheWrite: rateText(price?.cacheWrite),
  }
}

function rateText(value: number | undefined): string {
  return value == null ? "" : String(value)
}

/** True when the row has nothing in it at all. */
export function isBlankPriceForm(form: PriceForm): boolean {
  return PRICE_FIELDS.every((field) => form[field.key].trim() === "")
}

/**
 * Blank cache rates are left out, and the ratios `lib/model-pricing` already
 * applies take over; an explicit `0` is free. Input and output are required
 * together: a model priced on one side only would under-report every turn,
 * which is worse than reporting it as unpriced.
 */
export function parsePriceForm(form: PriceForm): PriceFormResult {
  if (isBlankPriceForm(form)) return { status: "empty" }

  const rates: Partial<Record<PriceField, number>> = {}
  for (const field of PRICE_FIELDS) {
    const raw = form[field.key].trim()
    if (raw === "") {
      if (field.optional) continue
      return {
        status: "error",
        field: field.key,
        message: "Input and output are both needed to price a model.",
      }
    }
    if (!RATE_RE.test(raw)) {
      return {
        status: "error",
        field: field.key,
        message: `${field.label} must be a number with up to 6 decimals, and not negative.`,
      }
    }
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) {
      return {
        status: "error",
        field: field.key,
        message: `${field.label} must be a number with up to 6 decimals, and not negative.`,
      }
    }
    rates[field.key] = value
  }

  if (rates.input === undefined || rates.output === undefined) {
    return {
      status: "error",
      field: rates.input === undefined ? "input" : "output",
      message: "Input and output are both needed to price a model.",
    }
  }

  return {
    status: "ok",
    price: {
      input: rates.input,
      output: rates.output,
      ...(rates.cacheRead === undefined ? {} : { cacheRead: rates.cacheRead }),
      ...(rates.cacheWrite === undefined
        ? {}
        : { cacheWrite: rates.cacheWrite }),
    },
  }
}
