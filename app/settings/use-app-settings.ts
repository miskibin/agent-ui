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
 * `editor`, `memory` and `handoff` parts of settings.json — every subtree this
 * panel edits, and no other.
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
  const latest = React.useRef<AppSettings>(DEFAULT_SETTINGS)
  const pending = React.useRef<AppSettings | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )

  const flush = React.useCallback(async () => {
    const next = pending.current
    if (!next) return
    pending.current = null
    try {
      await writeSettings((current) => ({
        ...current,
        providers: next.providers,
        modelProviders: next.modelProviders,
        chat: next.chat,
        files: next.files,
        editor: next.editor,
        memory: next.memory,
        handoff: next.handoff,
      }))
    } catch {
      toast.error("Couldn't save settings.")
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
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (cancelled || data == null) return
        const next = normalizeSettings(data)
        latest.current = next
        setSettings(next)
      })
      .catch(() => {
        // Route not up yet: defaults stay on screen, nothing is written.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  React.useEffect(() => {
    const timerRef = timer
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void flush()
    }
  }, [flush])

  const update = React.useCallback<AppSettingsApi["update"]>(
    (updater) => {
      const next = normalizeSettings(updater(latest.current))
      latest.current = next
      pending.current = next
      setSettings(next)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), SAVE_DELAY)
    },
    [flush]
  )

  return { settings, loaded, update, flush: flushNow }
}
