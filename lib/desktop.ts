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

type TauriGlobal = {
  window?: { getCurrentWindow(): TauriWindow }
  os?: { platform(): string }
  dialog?: TauriDialog
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
 * tab has no such thing, and the picker falls back to its own directory
 * browser, which is the only option there anyway.
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
    title: "Choose a working folder",
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
