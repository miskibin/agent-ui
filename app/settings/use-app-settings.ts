"use client"

import * as React from "react"
import { toast } from "sonner"

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
}

/**
 * Reads and writes the `providers`, `chat`, `files` and `memory` parts of
 * settings.json.
 *
 * Appearance deliberately stays out of the write path — it is owned by
 * `lib/theme/theme-client` — and every save re-reads the file first, so the two
 * writers can never clobber each other's subtree.
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
      const res = await fetch("/api/settings")
      const current = res.ok
        ? normalizeSettings(await res.json())
        : DEFAULT_SETTINGS
      const put = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...current,
          providers: next.providers,
          chat: next.chat,
          files: next.files,
          memory: next.memory,
        }),
      })
      if (!put.ok) throw new Error(`PUT /api/settings ${put.status}`)
    } catch {
      toast.error("Couldn't save settings.")
    }
  }, [])

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

  return { settings, loaded, update }
}
