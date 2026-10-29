"use client"

import * as React from "react"
import { toast } from "sonner"

import { writeSettings } from "@/lib/settings/client"
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type AppSettings,
} from "@/lib/settings/schema"

const SAVE_DELAY = 400

export type AppSettingsApi = {
  settings: AppSettings
  /** False until the first GET settles; sections render skeletons meanwhile. */
  loaded: boolean
  loadError: boolean
  retry: () => void
  /** Optimistic: state updates now, the merged object is PUT on a debounce. */
  update: (updater: (current: AppSettings) => AppSettings) => void
  /**
   * Writes whatever the debounce is still holding, now. Anything that asks the
   * server about a value the user just typed — the "Test" buttons — has to
   * await this first, because the routes read settings.json, not this state.
   */
  flush: () => Promise<void>
}

/**
 * Reads and writes the `providers`, `modelProviders`, `chat`, `files`,
 * `editor`, `memory`, `handoff`, `checkpoints` and `usage` parts of
 * settings.json — every subtree this panel edits, and no other.
 *
 * `appearance` (owned by `lib/theme/theme-client`) and `recentFolders` (the
 * folder picker, through `lib/api-client`) deliberately stay out of the write
 * body and are written back exactly as read. Saves go through
 * `lib/settings/client`, which serialises them against the other writers so a
 * concurrent read-modify-write cannot put a stale subtree back.
 */
export function useAppSettings(): AppSettingsApi {
  const [settings, setSettings] = React.useState<AppSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = React.useState(false)
  const [loadError, setLoadError] = React.useState(false)
  const [loadToken, setLoadToken] = React.useState(0)
  const ready = React.useRef(false)
  const latest = React.useRef<AppSettings>(DEFAULT_SETTINGS)
  const pending = React.useRef<AppSettings | null>(null)
  const saving = React.useRef<Promise<void> | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )

  const flush = React.useCallback(async () => {
    const next = pending.current
    if (!next) {
      // The debounce may already have started the write. Refresh still has
      // to wait for that request, even though there is nothing left pending.
      await saving.current
      return
    }
    pending.current = null
    const write = writeSettings((current) => ({
      ...current,
      providers: next.providers,
      modelProviders: next.modelProviders,
      chat: next.chat,
      files: next.files,
      editor: next.editor,
      memory: next.memory,
      handoff: next.handoff,
      checkpoints: next.checkpoints,
      usage: next.usage,
    }))
    saving.current = write
    try {
      await write
    } catch {
      if (!pending.current) pending.current = next
      toast.error("Couldn't save settings.")
      throw new Error("Could not save settings")
    } finally {
      if (saving.current === write) saving.current = null
    }
  }, [])

  /** The debounce is part of the pending write, so cancel it before flushing. */
  const flushNow = React.useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = undefined
    await flush()
  }, [flush])

  React.useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    fetch("/api/settings", { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error("Could not load settings")
        return res.json()
      })
      .then((data: unknown) => {
        if (cancelled || data == null) return
        const next = normalizeSettings(data)
        latest.current = next
        ready.current = true
        setSettings(next)
        setLoaded(true)
        setLoadError(false)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [loadToken])

  React.useEffect(() => {
    const timerRef = timer
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void flush().catch(() => {})
    }
  }, [flush])

  const update = React.useCallback<AppSettingsApi["update"]>(
    (updater) => {
      if (!ready.current) return
      const next = normalizeSettings(updater(latest.current))
      latest.current = next
      pending.current = next
      setSettings(next)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush().catch(() => {}), SAVE_DELAY)
    },
    [flush]
  )

  const retry = React.useCallback(() => setLoadToken((token) => token + 1), [])
  return { settings, loaded, loadError, retry, update, flush: flushNow }
}
