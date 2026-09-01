/**
 * Bridge to the Tauri desktop shell. The shell is configured with
 * `app.withGlobalTauri: true`, so everything here goes through the injected
 * `window.__TAURI__` global — no npm dependency, and every call is a safe
 * no-op in a plain browser tab.
 */

type TauriWindow = {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  onResized(cb: () => void): Promise<() => void>
}

/** Shape of `Update` as the updater plugin's IIFE bundle exposes it. */
type TauriUpdate = {
  version: string
  currentVersion: string
  body?: string
  date?: string
  downloadAndInstall(
    onEvent?: (event: TauriDownloadEvent) => void
  ): Promise<void>
  close(): Promise<void>
}

type TauriDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" }

type TauriGlobal = {
  window?: { getCurrentWindow(): TauriWindow }
  os?: { platform(): string }
  updater?: { check(): Promise<TauriUpdate | null> }
  process?: { relaunch(): Promise<void> }
}

function tauri(): TauriGlobal | null {
  if (typeof window === "undefined") return null
  return (window as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null
}

/** True when running inside the desktop shell. */
export function isDesktop(): boolean {
  return tauri() !== null
}

/**
 * True on macOS in the shell, where the native traffic lights overlay the
 * header and custom window controls must not render.
 */
export function hasNativeWindowControls(): boolean {
  const platform = tauri()?.os?.platform()
  return platform === "macos"
}

export type WindowAction = "minimize" | "toggle-maximize" | "close"

export async function windowAction(action: WindowAction): Promise<void> {
  const current = tauri()?.window?.getCurrentWindow()
  if (!current) return
  if (action === "minimize") await current.minimize()
  else if (action === "toggle-maximize") await current.toggleMaximize()
  else await current.close()
}

export async function isMaximized(): Promise<boolean> {
  const current = tauri()?.window?.getCurrentWindow()
  if (!current) return false
  return current.isMaximized()
}

/**
 * Subscribe to maximize-state changes (fires on any resize). Returns an
 * unsubscribe; resolves to a no-op outside the shell.
 */
export async function onMaximizedChange(
  cb: (maximized: boolean) => void
): Promise<() => void> {
  const current = tauri()?.window?.getCurrentWindow()
  if (!current) return () => {}
  return current.onResized(() => {
    void current.isMaximized().then(cb)
  })
}

/* -------------------------------------------------------------------------- */
/* Updater                                                                     */
/* -------------------------------------------------------------------------- */

/** A release newer than the running one, as reported by the update endpoint. */
export type DesktopUpdate = {
  /** Version being offered, e.g. `0.2.0`. */
  version: string
  /** Version currently running. */
  currentVersion: string
  /** Release notes, when the endpoint published any. */
  notes?: string
  /** Publication date, verbatim from the endpoint. */
  date?: string
  /**
   * Downloads and installs the update. Resolves once the app is staged and
   * ready for {@link relaunch}; rejects on a network or signature failure.
   */
  install(onProgress?: (fraction: number | null) => void): Promise<void>
  /** Releases the update handle when the offer is dismissed. */
  dismiss(): Promise<void>
}

/**
 * Asks the update endpoint whether a newer release exists. Resolves to `null`
 * outside the desktop shell and when the app is already current; rejects only
 * on a real failure (offline, malformed manifest), which callers are expected
 * to swallow or surface as a toast.
 */
export async function checkForUpdate(): Promise<DesktopUpdate | null> {
  const updater = tauri()?.updater
  if (!updater) return null

  const update = await updater.check()
  if (!update) return null

  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body || undefined,
    date: update.date || undefined,
    install: (onProgress) => {
      const fraction = downloadProgress()
      return update.downloadAndInstall((event) => {
        onProgress?.(fraction(event))
      })
    },
    dismiss: async () => {
      try {
        await update.close()
      } catch {
        /* the handle is gone already — nothing to release */
      }
    },
  }
}

/**
 * Restarts the app so a staged update takes effect. A no-op in a browser tab.
 */
export async function relaunch(): Promise<void> {
  const process = tauri()?.process
  if (!process) return
  await process.relaunch()
}

/**
 * Accumulator turning the plugin's byte-chunk events into a 0–1 fraction.
 * `null` while the total size is unknown — some endpoints omit
 * `Content-Length`. One instance per download.
 */
function downloadProgress(): (event: TauriDownloadEvent) => number | null {
  let total = 0
  let received = 0
  return (event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0
      received = 0
    } else if (event.event === "Progress") {
      received += event.data.chunkLength
    } else {
      received = total
    }
    if (total <= 0) return null
    return Math.min(1, received / total)
  }
}
