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

type TauriDialog = {
  open(options: {
    directory?: boolean
    multiple?: boolean
    defaultPath?: string
    title?: string
  }): Promise<string | string[] | null>
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
  dialog?: TauriDialog
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

/**
 * True when the shell can show the OS folder chooser (the `dialog` plugin is
 * registered in `src-tauri`). Feature-detected rather than assumed: a browser
 * tab has no native dialog capable of returning an absolute local path.
 */
export function hasNativeFolderPicker(): boolean {
  return typeof tauri()?.dialog?.open === "function"
}

/**
 * Opens the OS folder chooser and resolves to the absolute path, or `null` if
 * the user cancelled — or if there is no shell to ask.
 */
export async function pickFolderNative(
  defaultPath?: string
): Promise<string | null> {
  const dialog = tauri()?.dialog
  if (!dialog) return null
  const picked = await dialog.open({
    directory: true,
    multiple: false,
    title: "Open Folder",
    ...(defaultPath ? { defaultPath } : null),
  })
  // `multiple: false` answers with a string, but the plugin's signature does
  // not know that — take the first either way.
  const path = Array.isArray(picked) ? picked[0] : picked
  return path ?? null
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

/* -------------------------------------------------------------------------- */
/* Attention: notifications, badge, focus                                      */
/* -------------------------------------------------------------------------- */

type TauriNotification = {
  isPermissionGranted(): Promise<boolean>
  requestPermission(): Promise<"granted" | "denied" | "default">
  sendNotification(options: { title: string; body?: string }): void
}

type TauriAttentionWindow = {
  isFocused(): Promise<boolean>
  setFocus(): Promise<void>
  setBadgeCount(count?: number): Promise<void>
  requestUserAttention(kind: number | null): Promise<void>
}

function attentionWindow(): TauriAttentionWindow | null {
  const current = tauri()?.window?.getCurrentWindow() as
    | (TauriWindow & Partial<TauriAttentionWindow>)
    | undefined
  if (!current || typeof current.isFocused !== "function") return null
  return current as TauriAttentionWindow
}

function notificationApi(): TauriNotification | null {
  const api = (tauri() as { notification?: TauriNotification } | null)
    ?.notification
  return api && typeof api.sendNotification === "function" ? api : null
}

/**
 * True when the desktop window is the one the user is looking at. In a
 * browser tab the document's own focus is the answer.
 */
export async function isWindowFocused(): Promise<boolean> {
  const current = attentionWindow()
  if (current) {
    try {
      return await current.isFocused()
    } catch {
      /* fall through to the document */
    }
  }
  return typeof document !== "undefined" && document.hasFocus()
}

/** Brings the window to the front — a click on a notification lands here. */
export async function focusWindow(): Promise<void> {
  const current = attentionWindow()
  if (current) {
    try {
      await current.setFocus()
      return
    } catch {
      /* not fatal */
    }
  }
  if (typeof window !== "undefined") window.focus()
}

/**
 * Posts an OS notification through the shell's plugin. Resolves `false` when
 * there is no shell or the user refused, so the caller can fall back to the
 * browser's own `Notification`.
 */
export async function notifyNative(
  title: string,
  body?: string
): Promise<boolean> {
  const api = notificationApi()
  if (!api) return false
  try {
    let granted = await api.isPermissionGranted()
    if (!granted) granted = (await api.requestPermission()) === "granted"
    if (!granted) return false
    api.sendNotification(body ? { title, body } : { title })
    return true
  } catch {
    return false
  }
}

/**
 * Number on the dock / taskbar icon; 0 clears it. macOS and Linux docks
 * carry a count; Windows has no badge, so the taskbar is flashed instead
 * (see {@link requestAttention}). No-op outside the shell.
 */
export async function setBadgeCount(count: number): Promise<void> {
  const current = attentionWindow()
  if (!current) return
  try {
    await current.setBadgeCount(count > 0 ? count : undefined)
  } catch {
    /* the platform has no badge */
  }
}

/**
 * Bounces the dock icon / flashes the taskbar once. `informational` — the
 * gentle kind — rather than `critical`, which keeps bouncing until clicked.
 */
export async function requestAttention(): Promise<void> {
  const current = attentionWindow()
  if (!current) return
  try {
    // Tauri's UserAttentionType: 1 = Critical, 2 = Informational.
    await current.requestUserAttention(2)
  } catch {
    /* unsupported here */
  }
}

/**
 * Opens a URL in the system browser. The shell plugin's `open` does it from
 * the desktop app, where a `target="_blank"` anchor has no window to open
 * into; a browser tab just opens a tab.
 */
export async function openExternal(url: string): Promise<void> {
  const shell = (tauri() as { shell?: { open(path: string): Promise<void> } } | null)
    ?.shell
  if (shell && typeof shell.open === "function") {
    try {
      await shell.open(url)
      return
    } catch {
      /* fall through */
    }
  }
  if (typeof window !== "undefined") window.open(url, "_blank", "noopener")
}
