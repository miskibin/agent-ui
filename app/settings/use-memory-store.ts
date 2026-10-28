"use client"

import * as React from "react"
import { toast } from "sonner"

import * as api from "@/lib/api-client"
import type { MemoryFile } from "@/lib/memory/types"

export type MemoryFileDraft = {
  name: string
  description: string
  content: string
}

export type MemoryStoreApi = {
  files: MemoryFile[]
  dir: string
  bytes: number
  loading: boolean
  /** File currently being written, so its row can disable itself. */
  saving: string | null
  /** `previousName` renames; resolves false (after a toast) when refused. */
  save: (draft: MemoryFileDraft, previousName?: string) => Promise<boolean>
  remove: (name: string) => Promise<boolean>
  clear: () => Promise<void>
  reload: () => void
}

/**
 * The settings page's view of `~/.agent-ui/memory`.
 *
 * Reads and writes go straight to `/api/memory` rather than through the
 * settings blob: the files are the store, and a user editing one is editing
 * the thing the agent will actually be handed, not a copy of it. Agents write
 * the same files during turns, so the page re-reads whenever it is shown.
 */
export function useMemoryStore(): MemoryStoreApi {
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
  }, [nonce])

  const reload = React.useCallback(() => setNonce((value) => value + 1), [])

  const save = React.useCallback(
    async (draft: MemoryFileDraft, previousName?: string) => {
      setSaving(previousName ?? draft.name)
      try {
        setStore(await api.putMemoryFile({ ...draft, previousName }))
        return true
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't save memory.")
        return false
      } finally {
        setSaving(null)
      }
    },
    []
  )

  const remove = React.useCallback(async (name: string) => {
    setSaving(name)
    try {
      setStore(await api.deleteMemoryFile(name))
      return true
    } catch {
      toast.error("Couldn't delete that file.")
      return false
    } finally {
      setSaving(null)
    }
  }, [])

  const clear = React.useCallback(async () => {
    try {
      setStore(await api.deleteMemoryFile())
      toast.success("Memory cleared.")
    } catch {
      toast.error("Couldn't clear memory.")
    }
  }, [])

  return {
    files: store?.files ?? [],
    dir: store?.dir ?? "",
    bytes: store?.bytes ?? 0,
    loading,
    saving,
    save,
    remove,
    clear,
    reload,
  }
}
