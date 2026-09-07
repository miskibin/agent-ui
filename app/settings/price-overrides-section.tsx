"use client"

import * as React from "react"
import { RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  priceForModel,
  priceSource,
  type PriceSource,
} from "@/lib/model-pricing"
import type { ModelPriceOverride } from "@/lib/settings/schema"
import type { UsageModelRow } from "@/lib/usage"
import { cn } from "@/lib/utils"

import { SettingsRow } from "./section"
import type { AppSettingsApi } from "./use-app-settings"
import {
  PRICE_FIELDS,
  PRICE_HINT,
  parsePriceForm,
  priceForm,
  type PriceField,
  type PriceForm,
} from "./usage-price-form"

/**
 * What the user says a model costs, for the models this machine has actually
 * run. Lives inside Settings → Usage, right under the tables the prices move.
 *
 * The list is the usage report's own model rows plus any id already carrying
 * an override, unpriced models first: the whole point of the editor is the
 * turn that shows a dash instead of a number, so that is what it opens on.
 * Nothing here is a separate store — an entry is one key in
 * `settings.usage.priceOverrides`, written through the same debounced chain
 * as every other setting, and applied to past and future turns alike.
 *
 * Editing is inline and per field: a box that parses is saved, a box that
 * does not says why and leaves the stored price alone, and clearing every box
 * in a row removes the override rather than storing a zero — zero is a price
 * (free), and "no opinion" needs its own way to be said.
 */

type PriceRow = {
  model: string
  providerId: string
  /** Undefined for an id that only exists as an override. */
  usage?: UsageModelRow
  source: PriceSource
}

export function PriceOverridesSection({
  models,
  settings,
  loaded,
  update,
  flush,
  onSaved,
}: {
  /** Per-model rows from `GET /api/usage`; empty while it loads. */
  models: UsageModelRow[]
  /**
   * Called once an edit has actually reached settings.json. The tables above
   * are priced server-side, so they are re-read then — on leaving a field,
   * not on every keystroke, which is also what keeps the debounced save a
   * debounced save.
   */
  onSaved: () => void
} & Pick<AppSettingsApi, "settings" | "loaded" | "update" | "flush">) {
  const overrides = settings.usage.priceOverrides

  /**
   * What is in the boxes, for the rows the user has touched. Everything else
   * renders straight off the stored override, so a save landing (or another
   * window's edit arriving) is visible immediately.
   */
  const [drafts, setDrafts] = React.useState<Record<string, PriceForm>>({})
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})

  const rows = React.useMemo<PriceRow[]>(() => {
    const seen = new Map<string, PriceRow>()
    for (const row of models) {
      if (!row.model || seen.has(row.model)) continue
      seen.set(row.model, {
        model: row.model,
        providerId: row.providerId,
        usage: row,
        source: priceSource(row.model, row.providerId, overrides),
      })
    }
    for (const model of Object.keys(overrides)) {
      if (seen.has(model)) continue
      seen.set(model, { model, providerId: "", source: "override" })
    }
    // Unpriced first — they are why this editor exists — then the busiest.
    return [...seen.values()].sort(
      (a, b) =>
        rank(a.source) - rank(b.source) ||
        (b.usage?.tokens ?? 0) - (a.usage?.tokens ?? 0) ||
        a.model.localeCompare(b.model)
    )
  }, [models, overrides])

  const writeOverride = React.useCallback(
    (model: string, price: ModelPriceOverride | null) => {
      update((current) => {
        const next = { ...current.usage.priceOverrides }
        if (price) next[model] = price
        else delete next[model]
        return { ...current, usage: { ...current.usage, priceOverrides: next } }
      })
    },
    [update]
  )

  const editField = React.useCallback(
    (row: PriceRow, current: PriceForm, field: PriceField, value: string) => {
      const form = { ...current, [field]: value }
      setDrafts((drafts) => ({ ...drafts, [row.model]: form }))
      const parsed = parsePriceForm(form)
      setErrors((errors) => ({
        ...errors,
        [row.model]: parsed.status === "error" ? parsed.message : "",
      }))
      if (parsed.status === "ok") writeOverride(row.model, parsed.price)
      else if (parsed.status === "empty") writeOverride(row.model, null)
    },
    [writeOverride]
  )

  /** Leaving a row: write what the debounce is holding, then re-read usage. */
  const commit = React.useCallback(() => {
    void flush().then(onSaved)
  }, [flush, onSaved])

  const reset = React.useCallback(
    (model: string) => {
      setDrafts((drafts) => ({ ...drafts, [model]: priceForm() }))
      setErrors((errors) => ({ ...errors, [model]: "" }))
      writeOverride(model, null)
      commit()
    },
    [commit, writeOverride]
  )

  const unpriced = rows.filter((row) => row.source === "unpriced").length

  return (
    <SettingsRow
      title="Model prices"
      description={
        unpriced > 0
          ? `${unpriced} ${unpriced === 1 ? "model has" : "models have"} no price this app knows — give one here and every turn it ran is counted. ${PRICE_HINT}`
          : `Correct what a model costs, or price one this app doesn't know. ${PRICE_HINT}`
      }
    >
      {rows.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Nothing to price yet — a model shows up here once a turn on it has
          reported its tokens.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map((row) => {
            const stored = overrides[row.model]
            const form = drafts[row.model] ?? priceForm(stored)
            const showCache =
              expanded[row.model] ??
              (stored?.cacheRead != null || stored?.cacheWrite != null)
            return (
              <li key={row.model} className="flex flex-col gap-2 px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span
                      title={
                        row.providerId
                          ? `${row.model} · ${row.providerId}`
                          : row.model
                      }
                      className="truncate font-mono text-[11.5px] text-foreground"
                    >
                      {row.model}
                    </span>
                    <SourceTag source={row.source} />
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-pressed={showCache}
                      onClick={() =>
                        setExpanded((current) => ({
                          ...current,
                          [row.model]: !showCache,
                        }))
                      }
                      className="rounded-md px-1.5 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {showCache ? "Hide cache rates" : "Cache rates"}
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!loaded || !stored}
                      onClick={() => reset(row.model)}
                      className="h-7 gap-1.5 px-2 text-[11.5px]"
                    >
                      <RotateCcw className="size-3" />
                      Reset to automatic
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {PRICE_FIELDS.filter(
                    (field) => showCache || !field.optional
                  ).map((field) => (
                    <label key={field.key} className="flex flex-col gap-1">
                      <span className="text-[11px] text-muted-foreground">
                        {field.label}
                      </span>
                      <Input
                        value={form[field.key]}
                        inputMode="decimal"
                        disabled={!loaded}
                        // The built-in price, so an empty box says what it is
                        // falling back to rather than sitting blank.
                        placeholder={automaticText(row, field.key)}
                        onChange={(event) =>
                          editField(row, form, field.key, event.target.value)
                        }
                        onBlur={commit}
                        className="h-8 text-[12px] tabular-nums"
                        aria-label={`${field.label} price for ${row.model}`}
                      />
                    </label>
                  ))}
                </div>

                {errors[row.model] ? (
                  <p className="text-[11.5px] text-destructive">
                    {errors[row.model]}
                  </p>
                ) : row.usage ? (
                  <p className="text-[11px] text-muted-foreground tabular-nums">
                    {row.usage.turns} {row.usage.turns === 1 ? "turn" : "turns"}{" "}
                    in this window
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </SettingsRow>
  )
}

function rank(source: PriceSource) {
  return source === "unpriced" ? 0 : source === "override" ? 1 : 2
}

/**
 * What the box falls back to when it is left empty — the built-in rate itself
 * where there is one, so correcting a price starts from the number being
 * corrected. The cache boxes say "auto" rather than a figure: left empty they
 * are derived from whichever input rate ends up applying, list or custom.
 */
function automaticText(row: PriceRow, field: PriceField): string {
  if (field === "cacheRead" || field === "cacheWrite") return "auto"
  const builtin = priceForModel(row.model, row.providerId)
  if (!builtin) return "not priced"
  return String(field === "input" ? builtin.input : builtin.output)
}

const TAGS: Record<PriceSource, { label: string; className: string }> = {
  override: {
    label: "Custom",
    className: "border-primary/30 bg-primary/10 text-foreground",
  },
  builtin: {
    label: "Built-in",
    className: "border-border bg-muted/60 text-muted-foreground",
  },
  unpriced: {
    label: "Unpriced",
    className: "border-border bg-muted/40 text-muted-foreground",
  },
}

function SourceTag({ source }: { source: PriceSource }) {
  const tag = TAGS[source]
  return (
    <span
      data-slot="price-source"
      data-source={source}
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-px text-[10px] leading-4",
        tag.className
      )}
    >
      {tag.label}
    </span>
  )
}
