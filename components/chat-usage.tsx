"use client"

import { Coins } from "lucide-react"
import * as React from "react"

import { AppHeaderButton } from "@/components/app-header"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatCost, type ModelPriceOverrides } from "@/lib/model-pricing"
import { formatTokens, repriceUsage, type ChatUsage } from "@/lib/usage"

/**
 * What this chat has spent, beside the count of files it changed.
 *
 * The control carries both numbers — the tokens the chat has burned and what
 * they are estimated to have cost — because only one of them is always
 * knowable: a chat on a local model has a real token total and no price at
 * all, and a harness whose bare ids this app cannot price has neither. When
 * only some of the turns could be priced, the popover says how many could not:
 * a partial sum that reads as the whole is worse than no sum, and an agent
 * chat routinely mixes a hosted model with a local one.
 *
 * Presentational: the aggregation is `lib/usage`'s, memoized upstream in
 * `app/hooks/use-thread-view`, so a streaming turn does not rebuild it. The
 * one thing done here is applying the user's own prices
 * (`settings.usage.priceOverrides`) to that aggregate — re-pricing four token
 * counts per model, never re-walking the transcript.
 */
export function ChatUsageSummary({
  usage: aggregate,
  priceOverrides,
}: {
  usage: ChatUsage | null
  /**
   * The user's price table. Passed in where the page already holds settings;
   * left out, this reads it once itself rather than making the header wait on
   * a fetch it usually does not need.
   */
  priceOverrides?: ModelPriceOverrides
}) {
  const [open, setOpen] = React.useState(false)
  const overrides = usePriceOverrides(aggregate, priceOverrides)
  const usage = React.useMemo(
    () =>
      aggregate && overrides && Object.keys(overrides).length > 0
        ? repriceUsage(aggregate, overrides)
        : aggregate,
    [aggregate, overrides]
  )
  if (!usage || usage.turns === 0) return null

  const priced = usage.cost != null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <AppHeaderButton label={summaryLabel(usage)}>
          <Coins />
          <span className="text-[11px] tabular-nums">
            {formatTokens(usage.tokens)}
            {priced ? (
              <span className="text-muted-foreground">
                {" · "}
                {formatCost(usage.cost ?? 0)}
              </span>
            ) : null}
          </span>
        </AppHeaderButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-baseline justify-between gap-2 border-b px-3 py-2">
          <span className="text-[12px] font-medium text-foreground">
            Used in this chat
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {usage.turns} {usage.turns === 1 ? "turn" : "turns"}
          </span>
        </div>

        <dl className="flex flex-col gap-1.5 border-b px-3 py-2.5">
          <TotalRow
            label="Tokens"
            value={`${formatTokens(usage.inputTokens)} in · ${formatTokens(
              usage.outputTokens
            )} out`}
          />
          <TotalRow
            label="Estimated"
            value={priced ? `≈ ${formatCost(usage.cost ?? 0)}` : "unknown"}
          />
          {usage.cacheTokens > 0 ? (
            // Deliberately its own row rather than folded into "Tokens": these
            // are billed, at a tenth for a read and a quarter more for a
            // write, but they are not what the conversation weighs.
            <TotalRow
              label="Cached"
              value={`${formatTokens(usage.cacheTokens)} at cache rates`}
            />
          ) : null}
          {usage.unpricedTurns > 0 ? (
            <TotalRow
              label="Unpriced"
              value={`${usage.unpricedTurns} ${
                usage.unpricedTurns === 1 ? "turn" : "turns"
              } not counted`}
            />
          ) : null}
        </dl>

        <ul className="flex max-h-64 flex-col overflow-y-auto py-1">
          {usage.models.map((row) => (
            <li
              key={`${row.providerId} ${row.model}`}
              className="flex items-baseline gap-3 px-3 py-1.5"
            >
              <span
                title={row.model}
                className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground"
              >
                {row.model}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {formatTokens(row.tokens)}
              </span>
              <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-foreground">
                {row.cost == null ? "—" : formatCost(row.cost)}
              </span>
            </li>
          ))}
        </ul>

        <p className="border-t px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          An estimate from list prices — a cache read counts at a tenth and a
          cache write at a quarter more; batch rates are not tracked, and a
          local model is free.
        </p>
      </PopoverContent>
    </Popover>
  )
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-20 shrink-0 text-[11px] text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-[12px] text-foreground tabular-nums">
        {value}
      </dd>
    </div>
  )
}

/** The button's own accessible label — the whole sentence, not the glyph. */
function summaryLabel(usage: ChatUsage) {
  const tokens = `${formatTokens(usage.tokens)} tokens in this chat`
  const cost =
    usage.cost == null
      ? "no priced turns"
      : usage.cost === 0
        ? "free"
        : `about ${formatCost(usage.cost)}`
  const rest =
    usage.unpricedTurns > 0
      ? `, ${usage.unpricedTurns} unpriced ${
          usage.unpricedTurns === 1 ? "turn" : "turns"
        }`
      : ""
  return `${tokens}, ${cost}${rest}`
}

/* -------------------------------------------------------------------------- */
/* The price table                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `settings.usage.priceOverrides`, read straight off `GET /api/settings` and
 * held for a minute.
 *
 * The header is on the app's critical path, so this is deliberately the
 * cheapest thing that can work: nothing is fetched until a chat actually has
 * usage to price, one request is shared by every caller, and a table that has
 * not changed costs nothing to keep using. A price edited in the settings
 * panel shows up here on the next turn, which is soon enough for an estimate.
 */
const OVERRIDES_TTL = 60_000

let cached: { at: number; value: ModelPriceOverrides } | null = null
let inFlight: Promise<ModelPriceOverrides> | null = null

function loadPriceOverrides(): Promise<ModelPriceOverrides> {
  if (cached && Date.now() - cached.at < OVERRIDES_TTL) {
    return Promise.resolve(cached.value)
  }
  inFlight ??= fetch("/api/settings", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: unknown) => {
      const value = readOverrides(data)
      cached = { at: Date.now(), value }
      return value
    })
    .catch(() => cached?.value ?? {})
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/**
 * Only the fields this component prices with, checked one by one: the settings
 * file is hand-editable, and a string where a rate belongs must leave the
 * built-in price standing rather than produce `NaN` in a header.
 */
function readOverrides(data: unknown): ModelPriceOverrides {
  const usage = (data as { usage?: { priceOverrides?: unknown } } | null)?.usage
  const raw = usage?.priceOverrides
  if (!raw || typeof raw !== "object") return {}
  const out: ModelPriceOverrides = {}
  for (const [model, entry] of Object.entries(raw as Record<string, unknown>)) {
    const price = entry as Record<string, unknown> | null
    if (!price || typeof price !== "object") continue
    const input = rate(price.input)
    const output = rate(price.output)
    if (input == null || output == null) continue
    const cacheRead = rate(price.cacheRead)
    const cacheWrite = rate(price.cacheWrite)
    out[model] = {
      input,
      output,
      ...(cacheRead == null ? {} : { cacheRead }),
      ...(cacheWrite == null ? {} : { cacheWrite }),
    }
  }
  return out
}

function rate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function usePriceOverrides(
  usage: ChatUsage | null,
  given: ModelPriceOverrides | undefined
) {
  const [fetched, setFetched] = React.useState<ModelPriceOverrides | null>(
    () => cached?.value ?? null
  )

  React.useEffect(() => {
    if (!usage || given) return
    let cancelled = false
    void loadPriceOverrides().then((value) => {
      if (!cancelled) setFetched(value)
    })
    return () => {
      cancelled = true
    }
    // The aggregate's identity changes when a turn settles, which is the one
    // moment a stale table is worth re-checking; inside the TTL that costs a
    // resolved promise and re-renders nothing, because the value is the same
    // object.
  }, [usage, given])

  return given ?? fetched ?? undefined
}
