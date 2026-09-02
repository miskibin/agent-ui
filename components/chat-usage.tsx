"use client"

import { Coins } from "lucide-react"
import * as React from "react"

import { AppHeaderButton } from "@/components/app-header"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatCost } from "@/lib/model-pricing"
import { formatTokens, type ChatUsage } from "@/lib/usage"

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
 * `app/hooks/use-thread-view`, so a streaming turn does not rebuild it.
 */
export function ChatUsageSummary({ usage }: { usage: ChatUsage | null }) {
  const [open, setOpen] = React.useState(false)
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
          An estimate from list prices — caching and batch rates are not
          tracked, and a local model is free.
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
