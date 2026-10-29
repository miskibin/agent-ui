"use client"

import * as React from "react"

import { Check, CircleHelp, Minus, TriangleAlert } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Live provider availability for the settings page, read from
 * `/api/providers` — the same list the composer's picker renders.
 */

export type ProviderStatus = { available: boolean; detail?: string }
export type StatusPhase = "loading" | "ready" | "unavailable"
export type StatusState = {
  phase: StatusPhase
  map: Record<string, ProviderStatus>
}

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

export function useProviderStatus(enabled = true) {
  const requestId = React.useRef(0)
  const [state, setState] = React.useState<StatusState>({
    phase: "loading",
    map: {},
  })

  const refresh = React.useCallback(async (force = false) => {
    const id = ++requestId.current
    try {
      const res = await fetch(
        force ? "/api/providers?refresh=1" : "/api/providers",
        { cache: "no-store", signal: AbortSignal.timeout(15_000) }
      )
      if (!res.ok) throw new Error(String(res.status))
      const map = parseStatus(await res.json())
      if (id === requestId.current) setState({ phase: "ready", map })
      return map
    } catch {
      if (id === requestId.current) setState({ phase: "unavailable", map: {} })
      return null
    }
  }, [])

  React.useEffect(() => {
    // Microtask defer keeps the effect body setState-free for the strict
    // react-hooks rules; the fetch itself is async anyway.
    if (!enabled) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh()
    })
    return () => {
      cancelled = true
      requestId.current += 1
    }
  }, [enabled, refresh])

  return { ...state, refresh }
}

export function StatusBadge({
  phase,
  status,
  enabled = true,
}: {
  phase: StatusPhase
  status: ProviderStatus | undefined
  enabled?: boolean
}) {
  if (!enabled)
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
        <Minus aria-hidden="true" className="size-3" />
        Disabled
      </span>
    )
  if (phase === "loading") return <Skeleton className="h-4 w-14" />
  const unknown =
    phase === "unavailable" || !status || /^Disabled/i.test(status.detail ?? "")
  const available = !unknown && status.available
  const label = unknown
    ? "Not checked"
    : available
      ? "Ready"
      : /signed out|sign in|log.?in|auth/i.test(status.detail ?? "")
        ? "Sign in"
        : /binary|not found|no .* at/i.test(status.detail ?? "")
          ? "Not installed"
          : "Unavailable"
  const Icon = unknown ? CircleHelp : available ? Check : TriangleAlert
  return (
    <span
      title={unknown ? "Refresh to check availability" : status?.detail}
      className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground"
    >
      <Icon aria-hidden="true" className="size-3" />
      {label}
    </span>
  )
}
