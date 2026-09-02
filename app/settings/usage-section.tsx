"use client"

import * as React from "react"
import { toast } from "sonner"

import { Skeleton } from "@/components/ui/skeleton"
import * as api from "@/lib/api-client"
import { formatCost } from "@/lib/model-pricing"
import { formatTokens, type UsageReport, type UsageTotals } from "@/lib/usage"
import { cn } from "@/lib/utils"

import { SettingsRow, SettingsSection } from "./section"

/**
 * What every chat on this machine has cost, over a window.
 *
 * Read-only, and read from one route: `GET /api/usage` walks the store and
 * answers with rows already grouped, so this page never sees a transcript.
 * Cost is an estimate off `lib/model-pricing`'s list prices, which is why a
 * row that could not be priced says so instead of contributing a zero.
 */

const RANGES = [
  { id: "7", label: "7 days", days: 7 as const },
  { id: "30", label: "30 days", days: 30 as const },
  { id: "all", label: "All time", days: "all" as const },
]

type RangeId = (typeof RANGES)[number]["id"]

export function UsageSection() {
  const [range, setRange] = React.useState<RangeId>("30")
  /**
   * The answer *and* the window it answers for, in one piece of state, so
   * "still loading" is derived rather than set: switching the window shows the
   * skeleton again the moment it changes, and the effect body stays free of
   * the synchronous setState the strict hooks rules refuse.
   */
  const [loaded, setLoaded] = React.useState<{
    days: number | "all"
    report: UsageReport | null
  } | null>(null)

  const days = RANGES.find((item) => item.id === range)?.days ?? 30

  React.useEffect(() => {
    let cancelled = false
    api
      .fetchUsage(days)
      .then((report) => {
        if (!cancelled) setLoaded({ days, report })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoaded({ days, report: null })
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : "Couldn't read usage."
        )
      })
    return () => {
      cancelled = true
    }
  }, [days])

  const loading = loaded?.days !== days
  const report = loading ? null : (loaded?.report ?? null)
  const totals = report?.totals
  const empty = !loading && (!totals || totals.turns === 0)

  return (
    <SettingsSection
      id="usage"
      title="Usage"
      description="Tokens and estimated cost across every chat on this machine. An estimate from list prices — caching and batch rates are not tracked, and local models are free."
    >
      <SettingsRow
        title="Window"
        description="How far back the totals below reach."
        control={
          <div
            role="radiogroup"
            aria-label="Usage window"
            className="inline-flex items-center gap-0.5 rounded-md border bg-muted/40 p-0.5"
          >
            {RANGES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={range === item.id}
                onClick={() => setRange(item.id)}
                className={cn(
                  "rounded-[5px] px-2.5 py-1 text-[12px] outline-none transition-colors",
                  "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  range === item.id
                    ? "bg-background font-medium text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        }
      />

      <SettingsRow
        title="Totals"
        description={
          report && report.chats > 0
            ? `${report.chats} ${report.chats === 1 ? "chat" : "chats"} with recorded usage${
                report.lastTurnAt
                  ? ` · last turn ${new Date(report.lastTurnAt).toLocaleDateString()}`
                  : ""
              }`
            : "Turns that reported their token counts."
        }
      >
        {loading ? (
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((cell) => (
              <Skeleton key={cell} className="h-14 w-full opacity-40" />
            ))}
          </div>
        ) : empty ? (
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Nothing recorded in this window yet. A turn counts once its backend
            reports how many tokens it used.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat
                label="Input"
                value={formatTokens(totals?.inputTokens ?? 0)}
                exact={totals?.inputTokens ?? 0}
                hint="tokens"
              />
              <Stat
                label="Output"
                value={formatTokens(totals?.outputTokens ?? 0)}
                exact={totals?.outputTokens ?? 0}
                hint="tokens"
              />
              <Stat
                label="Estimated cost"
                value={totals?.cost == null ? "—" : formatCost(totals.cost)}
                hint={`${totals?.turns ?? 0} ${
                  (totals?.turns ?? 0) === 1 ? "turn" : "turns"
                }`}
              />
            </div>
            {totals ? <UnpricedNote totals={totals} /> : null}
          </>
        )}
      </SettingsRow>

      {!loading && !empty && report ? (
        <>
          <SettingsRow
            title="By model"
            description={
              <>
                The id as the app spells it —{" "}
                <code className="font-mono text-[11.5px]">
                  &lt;provider&gt;/&lt;model&gt;
                </code>
                , or the bare tag a harness reports.
              </>
            }
          >
            <UsageTable
              head="Model"
              rows={report.models.map((row) => ({
                key: `${row.providerId} ${row.model}`,
                label: row.model,
                title: row.providerId
                  ? `${row.model} · ${row.providerId}`
                  : row.model,
                mono: true,
                totals: row,
              }))}
            />
          </SettingsRow>

          <SettingsRow
            title="By folder"
            description="The working folder each turn ran in."
          >
            <UsageTable
              head="Folder"
              rows={report.folders.map((row) => ({
                key: row.cwd || "no-folder",
                label: row.label,
                title: row.cwd || undefined,
                totals: row,
              }))}
            />
          </SettingsRow>
        </>
      ) : null}
    </SettingsSection>
  )
}

function UnpricedNote({ totals }: { totals: UsageTotals }) {
  if (totals.unpricedTurns === 0) return null
  return (
    <p className="mt-2.5 text-[12px] leading-snug text-muted-foreground">
      {totals.unpricedTurns}{" "}
      {totals.unpricedTurns === 1 ? "turn is" : "turns are"} not in that cost —
      their model has no price this app knows.
    </p>
  )
}

function Stat({
  label,
  value,
  exact,
  hint,
}: {
  label: string
  /** Rounded for the eye — `240k`. */
  value: string
  /** The count behind it, on hover, because this panel is about money. */
  exact?: number
  hint: string
}) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        title={exact == null ? undefined : exact.toLocaleString()}
        className="text-[15px] font-medium text-foreground tabular-nums"
      >
        {value}
      </p>
      <p className="text-[11px] text-muted-foreground tabular-nums">{hint}</p>
    </div>
  )
}

type UsageRow = {
  key: string
  label: string
  title?: string
  mono?: boolean
  totals: UsageTotals
}

function UsageTable({ head, rows }: { head: string; rows: UsageRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">Nothing to show yet.</p>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[26rem] border-collapse text-[12px]">
        <thead>
          <tr className="border-b text-left text-[11px] text-muted-foreground">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              {head}
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
              Turns
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
              Tokens
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b last:border-b-0">
              <th
                scope="row"
                title={row.title}
                className={cn(
                  "max-w-[16rem] truncate py-1.5 pr-3 text-left font-normal text-foreground",
                  row.mono && "font-mono text-[11.5px]"
                )}
              >
                {row.label}
              </th>
              <td className="py-1.5 pr-3 text-right text-muted-foreground tabular-nums">
                {row.totals.turns}
              </td>
              <td
                title={row.totals.tokens.toLocaleString()}
                className="py-1.5 pr-3 text-right text-muted-foreground tabular-nums"
              >
                {formatTokens(row.totals.tokens)}
              </td>
              <td
                title={
                  row.totals.unpricedTurns > 0
                    ? `${row.totals.unpricedTurns} unpriced`
                    : undefined
                }
                className="py-1.5 text-right text-foreground tabular-nums"
              >
                {row.totals.cost == null ? "—" : formatCost(row.totals.cost)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
