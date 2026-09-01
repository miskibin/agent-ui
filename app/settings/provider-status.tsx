"use client"

import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Live provider availability for the settings page, read from
 * `/api/providers` — the same list the composer's picker renders.
 */

export type ProviderStatus = { available: boolean; detail?: string }
export type StatusPhase = "loading" | "ready" | "unavailable"
export type StatusState = { phase: StatusPhase; map: Record<string, ProviderStatus> }

/** "cursor-agent", "cursorAgent" and "Cursor Agent" all collapse to one key. */
export function statusKey(id: string) {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function readAvailable(value: unknown): ProviderStatus | null {
  if (typeof value === "boolean") return { available: value }
  if (!value || typeof value !== "object") return null
  const entry = value as Record<string, unknown>
  const flag =
    entry.available ?? entry.reachable ?? entry.ok ?? entry.installed ?? null
  const status = typeof entry.status === "string" ? entry.status : null
  const available =
    typeof flag === "boolean"
      ? flag
      : status
        ? ["ok", "ready", "available", "online", "reachable"].includes(
            status.toLowerCase()
          )
        : false
  const detail = [
    entry.unavailableReason,
    entry.detail,
    entry.error,
    entry.message,
    entry.version,
  ].find((candidate) => typeof candidate === "string" && candidate.length > 0)
  return { available, detail: detail as string | undefined }
}

/**
 * `/api/providers` belongs to the agent runtime and its exact shape is still
 * settling, so this accepts an array, `{ providers: [...] }`, or an id-keyed
 * map, and treats anything it can't read as "status unknown".
 */
export function parseStatus(data: unknown): Record<string, ProviderStatus> {
  const map: Record<string, ProviderStatus> = {}
  const container = (data ?? {}) as Record<string, unknown>
  const list = Array.isArray(data)
    ? data
    : Array.isArray(container.providers)
      ? (container.providers as unknown[])
      : null

  if (list) {
    for (const item of list) {
      if (!item || typeof item !== "object") continue
      const entry = item as Record<string, unknown>
      const id = entry.id ?? entry.name ?? entry.provider
      if (typeof id !== "string") continue
      const status = readAvailable(entry)
      if (status) map[statusKey(id)] = status
    }
    return map
  }

  for (const [id, value] of Object.entries(container)) {
    const status = readAvailable(value)
    if (status) map[statusKey(id)] = status
  }
  return map
}

export function useProviderStatus() {
  const [state, setState] = React.useState<StatusState>({
    phase: "loading",
    map: {},
  })

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/providers", { cache: "no-store" })
      if (!res.ok) throw new Error(String(res.status))
      const map = parseStatus(await res.json())
      setState({ phase: "ready", map })
      return map
    } catch {
      setState({ phase: "unavailable", map: {} })
      return null
    }
  }, [])

  React.useEffect(() => {
    // Microtask defer keeps the effect body setState-free for the strict
    // react-hooks rules; the fetch itself is async anyway.
    queueMicrotask(() => void refresh())
  }, [refresh])

  return { ...state, refresh }
}

export function StatusBadge({
  phase,
  status,
}: {
  phase: StatusPhase
  status: ProviderStatus | undefined
}) {
  if (phase === "loading") return <Skeleton className="h-5 w-20" />
  if (phase === "unavailable") return null
  const available = status?.available ?? false

  return (
    <Badge
      variant={available ? "secondary" : "outline"}
      title={status?.detail}
      className="gap-1.5 text-[11px] font-normal"
    >
      <span
        className={
          available
            ? "size-1.5 rounded-full bg-emerald-500"
            : "size-1.5 rounded-full bg-muted-foreground/50"
        }
      />
      {available ? "Reachable" : "Unreachable"}
    </Badge>
  )
}
