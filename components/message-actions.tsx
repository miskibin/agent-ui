"use client"

import { Copy, Info, RefreshCw, Trash2 } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { folderName } from "@/lib/folder"
import type { StoredMessage } from "@/lib/store/types"
import { cn } from "@/lib/utils"

/**
 * The row under a settled assistant turn: copy, regenerate, delete, and — the
 * one that is not a verb — what actually produced the answer.
 *
 * The metadata lives behind a popover rather than under every message because
 * it is the thing you want once, about one turn: which model answered, how
 * long it took, what it spent, where it ran. Everything is optional; a backend
 * that reports no counters simply shows fewer rows, and the turn's own shape
 * (tool calls, reasoning, length) is derived here so there is always something
 * to read.
 */

const ACTION_BUTTON =
  "inline-grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-muted data-[state=open]:text-foreground [&_svg]:size-3.5"

export type MessageActionsProps = {
  message: StoredMessage
  /** Display name for `metadata.providerId`, which is an id, not a label. */
  providerName?: string
  onRegenerate: (id: string) => void
  onDelete: (id: string) => void
}

export const MessageActions = React.memo(function MessageActions({
  message,
  providerName,
  onRegenerate,
  onDelete,
}: MessageActionsProps) {
  return (
    <div className="-mt-2 mb-4 flex gap-1 opacity-60 transition-opacity focus-within:opacity-100 hover:opacity-100">
      <ActionBtn
        title="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(message.content)
          toast.success("Copied")
        }}
      >
        <Copy />
      </ActionBtn>
      <ActionBtn title="Regenerate" onClick={() => onRegenerate(message.id)}>
        <RefreshCw />
      </ActionBtn>
      <ActionBtn title="Delete" onClick={() => onDelete(message.id)}>
        <Trash2 />
      </ActionBtn>
      <MessageMetadata message={message} providerName={providerName} />
    </div>
  )
})

function ActionBtn({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={ACTION_BUTTON}
    >
      {children}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Metadata                                                                    */
/* -------------------------------------------------------------------------- */

type Row = { label: string; value: string; mono?: boolean }

function MessageMetadata({
  message,
  providerName,
}: {
  message: StoredMessage
  providerName?: string
}) {
  const [open, setOpen] = React.useState(false)
  /* Only built when the popover is actually opened — a settled transcript can
     be hundreds of turns, and none of this is on the streaming path. */
  const rows = React.useMemo(
    () => (open ? metadataRows(message, providerName) : []),
    [message, open, providerName]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        title="Response details"
        aria-label="Response details"
        className={ACTION_BUTTON}
      >
        <Info />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-[12px] font-medium text-foreground">
            Response details
          </span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(
                rows.map((row) => `${row.label}: ${row.value}`).join("\n")
              )
              toast.success("Details copied")
            }}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Copy className="size-3" />
            Copy
          </button>
        </div>
        <dl className="flex flex-col gap-1.5 px-3 py-2.5">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline gap-3">
              <dt className="w-24 shrink-0 text-[11px] text-muted-foreground">
                {row.label}
              </dt>
              <dd
                title={row.value}
                className={cn(
                  "min-w-0 flex-1 truncate text-[12px] text-foreground",
                  row.mono && "font-mono text-[11.5px] tabular-nums"
                )}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  )
}

function metadataRows(message: StoredMessage, providerName?: string): Row[] {
  const meta = message.metadata
  const rows: Row[] = []

  const provider = providerName ?? meta?.providerId
  if (provider) rows.push({ label: "Provider", value: provider })
  // The raw tag, not a display name: it is the thing you would paste back.
  if (meta?.model) rows.push({ label: "Model", value: meta.model, mono: true })

  const seconds = meta?.responseTime ?? message.workedFor
  if (seconds != null) {
    rows.push({ label: "Took", value: formatDuration(seconds), mono: true })
  }

  const input = meta?.inputTokens
  const output = meta?.outputTokens
  if (input != null || output != null) {
    rows.push({
      label: "Tokens",
      value: [
        input != null ? `${formatCount(input)} in` : null,
        output != null ? `${formatCount(output)} out` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      mono: true,
    })
  } else if (meta?.tokens != null) {
    // Turns stored before the split, and backends that only report a total.
    rows.push({ label: "Tokens", value: formatCount(meta.tokens), mono: true })
  }

  if (meta?.tokensPerSecond != null) {
    rows.push({
      label: "Speed",
      value: `${meta.tokensPerSecond.toFixed(1)} tok/s`,
      mono: true,
    })
  }

  const at = meta?.finishedAt ?? message.createdAt
  if (at != null) {
    rows.push({ label: "Finished", value: new Date(at).toLocaleString() })
  }

  if (meta?.cwd) {
    rows.push({
      label: "Folder",
      value: meta.gitBranch
        ? `${folderName(meta.cwd)} · ${meta.gitBranch}`
        : folderName(meta.cwd),
      mono: true,
    })
  }

  const shape = turnShape(message)
  if (shape) rows.push({ label: "Turn", value: shape })

  rows.push({
    label: "Length",
    value: `${formatCount(message.content.length)} characters`,
    mono: true,
  })

  return rows
}

/** "2 tool calls · 1 reasoning block" — what the turn was made of. */
function turnShape(message: StoredMessage): string {
  const parts = message.parts ?? []
  const tools = message.tools?.length
    ? message.tools.length
    : parts.filter((part) => part.type === "tool").length
  const thoughts = parts.filter(
    (part) => part.type === "thinking" && part.text.trim() !== ""
  ).length
  return [
    tools > 0 ? `${tools} tool ${tools === 1 ? "call" : "calls"}` : null,
    thoughts > 0
      ? `${thoughts} reasoning ${thoughts === 1 ? "block" : "blocks"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

function formatDuration(seconds: number) {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`
}

function formatCount(value: number) {
  return value.toLocaleString()
}
