"use client"

/**
 * Appearance state for the whole app.
 *
 * The value lives in a module-level store rather than provider state: the
 * provider renders a stable context value and never re-renders, so changing
 * theme or radius repaints via CSS variables and re-renders only the handful
 * of components that actually call `useAppearance()` (the settings controls).
 * `<AppearanceSync>` is the only subscriber mounted app-wide, and it renders
 * null.
 */

import * as React from "react"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type AppearanceSettings,
  type ThemeMode,
} from "@/lib/settings/schema"

import {
  applyAppearance,
  clampZoom,
  DEFAULT_ZOOM,
  normalizeContrast,
  normalizeRadiusOverride,
  normalizeZoom,
  readAppearanceMirror,
  writeAppearanceMirror,
  ZOOM_STEP,
} from "./apply"
import { findFont } from "./font-options"
import { findPreset } from "./presets"

const MODES: ThemeMode[] = ["light", "dark", "system"]

function asMode(value: unknown): ThemeMode | null {
  return MODES.includes(value as ThemeMode) ? (value as ThemeMode) : null
}

function normalizeAppearance(
  value: Partial<AppearanceSettings>
): AppearanceSettings {
  return {
    theme: findPreset(value.theme).id,
    mode: asMode(value.mode) ?? DEFAULT_SETTINGS.appearance.mode,
    contrast: normalizeContrast(value.contrast),
    radiusOverride: normalizeRadiusOverride(value.radiusOverride),
    fontSans:
      value.fontSans === undefined
        ? DEFAULT_SETTINGS.appearance.fontSans
        : findFont("sans", value.fontSans).id,
    fontMono:
      value.fontMono === undefined
        ? DEFAULT_SETTINGS.appearance.fontMono
        : findFont("mono", value.fontMono).id,
    zoom: normalizeZoom(value.zoom),
  }
}

function isSame(a: AppearanceSettings, b: AppearanceSettings) {
  return (
    a.theme === b.theme &&
    a.mode === b.mode &&
    a.contrast === b.contrast &&
    a.radiusOverride === b.radiusOverride &&
    a.fontSans === b.fontSans &&
    a.fontMono === b.fontMono &&
    a.zoom === b.zoom
  )
}

/* -------------------------------------------------------------------------
 * Store
 * ---------------------------------------------------------------------- */

let snapshot: AppearanceSettings = DEFAULT_SETTINGS.appearance
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => snapshot
const getServerSnapshot = () => DEFAULT_SETTINGS.appearance

/** Applies to the DOM, mirrors to localStorage, wakes subscribers. */
function commit(next: AppearanceSettings) {
  if (isSame(snapshot, next)) return false
  snapshot = next
  applyAppearance(next)
  writeAppearanceMirror(next)
  for (const listener of listeners) listener()
  return true
}

/* -------------------------------------------------------------------------
 * Persistence — settings.json holds the whole AppSettings object, so a write
 * is read-modify-write. Debounced so dragging the radius slider is one PUT.
 * ---------------------------------------------------------------------- */

const PERSIST_DELAY = 350
let persistTimer: ReturnType<typeof setTimeout> | undefined
let persistChain: Promise<void> = Promise.resolve()

async function putAppearance(appearance: AppearanceSettings) {
  const res = await fetch("/api/settings")
  if (!res.ok) throw new Error(`GET /api/settings ${res.status}`)
  const current = normalizeSettings(await res.json())
  const put = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...current, appearance }),
  })
  if (!put.ok) throw new Error(`PUT /api/settings ${put.status}`)
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    const appearance = snapshot
    persistChain = persistChain
      .then(() => putAppearance(appearance))
      .catch(() => {
        toast.error("Couldn't save appearance settings.")
      })
  }, PERSIST_DELAY)
}

/* -------------------------------------------------------------------------
 * Public setter
 * ---------------------------------------------------------------------- */

/** Set by `<AppearanceSync>`; mode changes are routed through next-themes. */
let applyMode: ((mode: ThemeMode) => void) | null = null

function setAppearance(patch: Partial<AppearanceSettings>) {
  const next = normalizeAppearance({ ...snapshot, ...patch })
  const modeChanged = next.mode !== snapshot.mode
  if (!commit(next)) return
  if (modeChanged) applyMode?.(next.mode)
  schedulePersist()
}

function zoomShortcut(event: KeyboardEvent): 1 | -1 | 0 | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) {
    return null
  }
  if (
    event.key === "+" ||
    event.key === "=" ||
    event.code === "Equal" ||
    event.code === "NumpadAdd"
  ) {
    return 1
  }
  if (
    event.key === "-" ||
    event.key === "−" ||
    event.code === "Minus" ||
    event.code === "NumpadSubtract"
  ) {
    return -1
  }
  if (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0") {
    return 0
  }
  return null
}

/** Zoom in (+1), out (−1), or reset to 100% (0). */
export function adjustZoom(direction: 1 | -1 | 0) {
  const zoom =
    direction === 0 ? DEFAULT_ZOOM : clampZoom(snapshot.zoom + direction * ZOOM_STEP)
  setAppearance({ zoom })
}

export type AppearanceApi = {
  appearance: AppearanceSettings
  /** Instant-apply. Optimistic: paints first, persists on a debounce. */
  setAppearance: (patch: Partial<AppearanceSettings>) => void
}

const AppearanceContext = React.createContext<{
  setAppearance: typeof setAppearance
} | null>(null)

export function useAppearance(): AppearanceApi {
  const ctx = React.useContext(AppearanceContext)
  if (!ctx) {
    throw new Error("useAppearance must be used inside <AppearanceProvider>")
  }
  const appearance = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  )
  return { appearance, setAppearance: ctx.setAppearance }
}

/* -------------------------------------------------------------------------
 * Provider
 * ---------------------------------------------------------------------- */

/**
 * Reconciles the three places appearance lives — the localStorage mirror (read
 * first, already applied by the pre-paint guard), `~/.agent-ui/settings.json`
 * (the source of truth) and next-themes' mode class. Renders nothing.
 */
function AppearanceSync() {
  const appearance = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  )
  const { theme, setTheme } = useTheme()
  const setThemeRef = React.useRef(setTheme)
  const readyRef = React.useRef(false)

  React.useEffect(() => {
    setThemeRef.current = setTheme
    applyMode = (mode) => setThemeRef.current(mode)
    return () => {
      applyMode = null
    }
  }, [setTheme])

  React.useEffect(() => {
    const mirror = readAppearanceMirror()
    if (mirror) commit(normalizeAppearance({ ...snapshot, ...mirror }))

    let cancelled = false
    const controller = new AbortController()
    fetch("/api/settings", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (cancelled || data == null) return
        const server = normalizeSettings(data).appearance
        commit(server)
        setThemeRef.current(server.mode)
      })
      .catch(() => {
        // Offline or route not up yet — the mirror already painted.
      })
      .finally(() => {
        if (!cancelled) readyRef.current = true
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  // Mode toggled elsewhere (e.g. the navbar theme toggle) writes back, so
  // settings.json never drifts from what the user is actually looking at.
  React.useEffect(() => {
    if (!readyRef.current) return
    const mode = asMode(theme)
    if (!mode || mode === appearance.mode) return
    setAppearance({ mode })
  }, [theme, appearance.mode])

  React.useEffect(() => {
    let wheelAcc = 0
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = zoomShortcut(event)
      if (direction === null) return
      event.preventDefault()
      adjustZoom(direction)
    }
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      event.preventDefault()
      wheelAcc += event.deltaY
      if (Math.abs(wheelAcc) < 40) return
      const direction: 1 | -1 = wheelAcc > 0 ? -1 : 1
      wheelAcc = 0
      adjustZoom(direction)
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    window.addEventListener("wheel", onWheel, { capture: true, passive: false })
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true })
      window.removeEventListener("wheel", onWheel, { capture: true })
    }
  }, [])

  return null
}

export function AppearanceProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const api = React.useMemo(() => ({ setAppearance }), [])
  return (
    <AppearanceContext.Provider value={api}>
      <AppearanceSync />
      {children}
    </AppearanceContext.Provider>
  )
}
