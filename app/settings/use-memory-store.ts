"use client"

import * as React from "react"
import { toast } from "sonner"

import * as api from "@/lib/api-client"
import type { MemoryFile } from "@/lib/memory/types"

export type MemoryStoreApi = {
  files: MemoryFile[]
  dir: string
  bytes: number
  budget: number
  ready: boolean
  reason?: string
  loading: boolean
  /** Category currently being written, so its row can disable itself. */
  saving: string | null
  save: (category: string, content: string) => Promise<boolean>
  remove: (category: string) => Promise<void>
  clear: () => Promise<void>
  reload: () => void
}

/**
 * The settings page's view of `~/.agent-ui/memory`.
 *
 * Reads and writes go straight to `/api/memory` rather than through the
 * settings blob: the files are the store, and a user editing one is editing
 * the thing the agent will actually be handed, not a copy of it.
 */
export function useMemoryStore(enabled: boolean): MemoryStoreApi {
  const [store, setStore] = React.useState<api.MemoryStore | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState<string | null>(null)
  const [nonce, setNonce] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    api
      .fetchMemory()
      .then((next) => {
        if (!cancelled) setStore(next)
      })
      .catch(() => {
        // A store that will not load is an empty one as far as this page is
        // concerned; the section says so rather than throwing a toast on mount.
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `enabled` is in the deps so flipping the switch re-reads `ready`/`reason`,
    // which is what turns the "why is nothing happening" line on and off.
  }, [nonce, enabled])

  const reload = React.useCallback(() => setNonce((value) => value + 1), [])

  const save = React.useCallback(async (category: string, content: string) => {
    setSaving(category)
    try {
      const next = await api.putMemoryFile(category, content)
      setStore((current) =>
        current ? { ...current, ...next } : current
      )
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save memory.")
      return false
    } finally {
      setSaving(null)
    }
  }, [])

  const remove = React.useCallback(async (category: string) => {
    setSaving(category)
    try {
      const next = await api.deleteMemoryFile(category)
      setStore((current) => (current ? { ...current, ...next } : current))
    } catch {
      toast.error("Couldn't delete that category.")
    } finally {
      setSaving(null)
    }
  }, [])

  const clear = React.useCallback(async () => {
    try {
      const next = await api.deleteMemoryFile()
      setStore((current) => (current ? { ...current, ...next } : current))
      toast.success("Memory cleared.")
    } catch {
      toast.error("Couldn't clear memory.")
    }
  }, [])

  return {
    files: store?.files ?? [],
    dir: store?.dir ?? "",
    bytes: store?.bytes ?? 0,
    budget: store?.budget ?? 0,
    ready: store?.ready ?? false,
    reason: store?.reason,
    loading,
    saving,
    save,
    remove,
    clear,
    reload,
  }
}
