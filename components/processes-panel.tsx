"use client"

import { Globe, Square, SquareTerminal, X } from "lucide-react"
import * as React from "react"

import { AppHeaderButton } from "@/components/app-header"
import { TimeAgo } from "@/components/live-time"
import type { BackgroundProcessRow } from "@/lib/api-client"
import { summarizeCommand } from "@/components/ui/message-parts"
import { tokenizeShell, type ShellTokenKind } from "@/lib/command-label"
import { openExternal } from "@/lib/desktop"
import { cn } from "@/lib/utils"

/**
 * What the chat's agents left running — the badge in the header and the list
 * in the side panel (`lib/background-processes` is where it comes from).
 *
 * T3 Code shows the same idea as one line at the foot of the timeline with a
 * single Stop for everything; here it is a list, because the processes are
 * not one thing — a dev server worth keeping beside a watcher that has done
 * its job — and each row stops on its own. A row is the command, tinted the
 * way the tool rows tint it, plus what the process table could say about it.
 */

/** The badge: how many, and the way into the list. */
export function ChatProcesses({
  count,
  open,
  onToggle,
}: {
  count: number
  open: boolean
  onToggle: () => void
}) {
  if (count === 0 && !open) return null
  return (
    <AppHeaderButton
      label={`${count} background ${count === 1 ? "process" : "processes"} running`}
      aria-expanded={open}
      data-active={open || undefined}
      data-slot="chat-processes"
      onClick={onToggle}
      className="data-[active=true]:bg-muted data-[active=true]:text-foreground"
    >
      <span className="relative inline-grid place-items-center">
        <SquareTerminal />
        {count > 0 ? (
          // The one moving part: something is still running out of sight.
          <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-emerald-500 ring-2 ring-background motion-safe:animate-pulse" />
        ) : null}
      </span>
      <span className="text-[11px] tabular-nums">{count}</span>
    </AppHeaderButton>
  )
}

const TOKEN_CLASSES: Record<ShellTokenKind, string | undefined> = {
  program: "text-foreground",
  flag: "text-muted-foreground",
  string: "text-chart-2",
  variable: "text-chart-2/80",
  operator: "text-muted-foreground",
  comment: "text-muted-foreground/70 italic",
  text: undefined,
}

function TintedCommand({ command }: { command: string }) {
  const tokens = React.useMemo(() => tokenizeShell(command), [command])
  return tokens.map((token, index) => {
    const className = TOKEN_CLASSES[token.kind]
    return className ? (
      <span key={index} className={className}>
        {token.text}
      </span>
    ) : (
      <React.Fragment key={index}>{token.text}</React.Fragment>
    )
  })
}

/**
 * What a row says: the command with its shell wrapper and `cd` peeled off —
 * `bash -c cd web && npm run dev` reads `npm run dev` — and the program that
 * actually runs as its name, the way a tool row's headline names it.
 */
function rowSummary(row: BackgroundProcessRow) {
  const summary = summarizeCommand(row.command)
  return {
    name: summary.program ?? row.name,
    display: summary.display || row.command,
  }
}

/** `/home/me/work/app` → `app`; the full path stays in the title. */
function folderName(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  )
}

const iconButton =
  "inline-grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3.5"

export function ProcessesPanel({
  processes,
  onStop,
  onClose,
  providerName,
  className,
}: {
  processes: BackgroundProcessRow[]
  /** One process (and its tree), or every one of them without a pid. */
  onStop: (pid?: number) => void
  onClose?: () => void
  /** The harness a row came from, by provider id. */
  providerName?: (providerId: string) => string | undefined
  className?: string
}) {
  return (
    <aside
      data-slot="processes-panel"
      aria-label="Background processes"
      className={className}
    >
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header
          data-slot="processes-panel-header"
          className="flex h-10 shrink-0 items-center gap-2 border-b px-2.5 text-[13px]"
        >
          <SquareTerminal className="size-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            Background processes
          </span>
          {processes.length > 1 ? (
            <button
              type="button"
              data-slot="processes-panel-stop-all"
              onClick={() => onStop()}
              className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3"
            >
              <Square className="fill-current" />
              Stop all
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              aria-label="Close background processes"
              title="Close"
              onClick={onClose}
              className={cn(iconButton, "[&_svg]:size-4")}
            >
              <X />
            </button>
          ) : null}
        </header>

        <div
          data-slot="processes-panel-body"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {processes.length === 0 ? (
            <div
              data-slot="processes-panel-empty"
              className="px-5 py-8 text-center text-[12.5px] leading-relaxed text-muted-foreground"
            >
              <p className="font-medium text-foreground/80">
                Nothing running in the background.
              </p>
              <p className="mt-1">
                A dev server, a watcher or anything else an agent leaves running
                after its turn shows up here, and can be stopped from here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {processes.map((row) => {
                const { name, display } = rowSummary(row)
                return (
                  <li
                    key={`${row.pid}:${row.startedAt}`}
                    data-slot="processes-panel-row"
                    className="group/row flex items-start gap-2 px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                        <span className="truncate text-[12.5px] font-medium text-foreground">
                          {name}
                        </span>
                        {row.url ? (
                          <button
                            type="button"
                            data-slot="processes-panel-url"
                            title={`Open ${row.url}`}
                            onClick={() => void openExternal(row.url as string)}
                            className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 text-[11.5px] text-sky-600 outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:text-sky-400 [&_svg]:size-3"
                          >
                            <Globe />
                            {row.url.replace(/^https?:\/\//, "")}
                          </button>
                        ) : null}
                      </div>
                      <p
                        className="mt-1 line-clamp-3 font-mono text-[11.5px] leading-snug break-all text-foreground/80"
                        title={row.command}
                      >
                        <TintedCommand command={display} />
                      </p>
                      <p className="mt-1 flex flex-wrap gap-x-1.5 text-[11px] text-muted-foreground">
                        <span className="tabular-nums">pid {row.pid}</span>
                        <span aria-hidden>·</span>
                        <span>
                          started <TimeAgo from={row.startedAt} />
                        </span>
                        {providerName?.(row.providerId) ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>{providerName(row.providerId)}</span>
                          </>
                        ) : null}
                        {row.cwd ? (
                          <>
                            <span aria-hidden>·</span>
                            <span className="truncate" title={row.cwd}>
                              {folderName(row.cwd)}
                            </span>
                          </>
                        ) : null}
                      </p>
                    </div>
                    <button
                      type="button"
                      data-slot="processes-panel-stop"
                      aria-label={`Stop ${name} (pid ${row.pid})`}
                      title="Stop this process and everything it started"
                      onClick={() => onStop(row.pid)}
                      className={cn(
                        iconButton,
                        "hover:bg-destructive/10 hover:text-destructive"
                      )}
                    >
                      <Square className="fill-current" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </aside>
  )
}
