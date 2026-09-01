"use client"

import * as React from "react"
import { toast } from "sonner"

import {
  checkForUpdate,
  isDesktop,
  relaunch,
  type DesktopUpdate,
} from "@/lib/desktop"

/**
 * Auto-update for the Tauri shell, kept entirely out of the critical path: the
 * first check is scheduled for an idle moment a few seconds after mount, and a
 * new release is announced with one dismissible toast rather than a modal.
 *
 * In a browser tab every entry point here is a no-op — `lib/desktop.ts` returns
 * `null` when the injected `window.__TAURI__` global is absent — so the same
 * code ships to the web build without a guard at every call site.
 */

/** Long enough for the first paint, the sidebar and the first stream to settle. */
const STARTUP_DELAY_MS = 5_000

/** One toast per version, so a manual re-check reuses the offer it already made. */
const toastId = (version: string) => `desktop-update-${version}`

/** Module scoped: a route change must not re-run the startup check. */
let startupCheckStarted = false
let checkInFlight = false
let installInFlight = false
/** Downloaded and waiting for a restart — nothing left to offer but that. */
let stagedVersion: string | null = null
/** Answered "Later" this session; only an explicit check asks again. */
let postponedVersion: string | null = null

export type UpdateCheckOptions = {
  /**
   * A user asked for it (command palette), so silence is not an answer:
   * "up to date" and failures both get a toast.
   */
  manual?: boolean
}

/**
 * Checks for a newer release and, if there is one, offers it. Never throws —
 * offline is the normal case for a local-first app.
 */
export async function checkForUpdates({
  manual = false,
}: UpdateCheckOptions = {}): Promise<void> {
  if (!isDesktop()) {
    if (manual) {
      toast.message("Updates are available in the desktop app", {
        description: "This tab runs the web build, which updates on reload.",
      })
    }
    return
  }

  if (stagedVersion) {
    // Already downloaded: re-checking would offer the same release again, and
    // the only useful action left is the restart.
    offerRestart(stagedVersion)
    return
  }
  if (installInFlight) {
    if (manual) toast.message("An update is already installing")
    return
  }
  if (checkInFlight) {
    if (manual) toast.message("Already checking for updates…")
    return
  }

  checkInFlight = true
  const pending = manual
    ? toast.loading("Checking for updates…", { duration: Infinity })
    : undefined

  try {
    const update = await checkForUpdate()
    if (pending !== undefined) toast.dismiss(pending)

    if (!update) {
      if (manual) toast.success("Agent UI is up to date")
      return
    }

    // "Later" means later, not "ask again the moment anything re-checks".
    if (!manual && postponedVersion === update.version) {
      await update.dismiss()
      return
    }

    offerUpdate(update)
  } catch (err) {
    if (pending !== undefined) toast.dismiss(pending)
    // Offline, a rate-limited endpoint, an unreachable release — none of it is
    // worth interrupting someone who did not ask.
    if (manual) {
      toast.error("Could not check for updates", {
        description: message(err),
      })
    }
  } finally {
    checkInFlight = false
  }
}

/** The unobtrusive part: an announcement with "Update" and "Later". */
function offerUpdate(update: DesktopUpdate) {
  const id = toastId(update.version)
  toast.message(`Agent UI ${update.version} is available`, {
    id,
    description: summarize(update),
    duration: Infinity,
    action: {
      label: "Update",
      onClick: () => void install(update),
    },
    cancel: {
      label: "Later",
      onClick: () => {
        postponedVersion = update.version
        void update.dismiss()
      },
    },
  })
}

/** The one thing left to do once a version is downloaded and staged. */
function offerRestart(version: string) {
  toast.success(`Agent UI ${version} is ready`, {
    id: toastId(version),
    description: "Restart to finish updating.",
    duration: Infinity,
    action: {
      label: "Restart",
      onClick: () => void relaunch(),
    },
  })
}

/** Download + stage, reporting progress in place, then offer the restart. */
async function install(update: DesktopUpdate) {
  if (installInFlight) return
  installInFlight = true

  const id = toastId(update.version)
  const label = `Downloading Agent UI ${update.version}`
  toast.loading(`${label}…`, { id, duration: Infinity })

  // Repainting the toast on every chunk would be pure churn; whole percents
  // are all the resolution a progress line has.
  let shown = -1

  try {
    await update.install((fraction) => {
      if (fraction === null) return
      const percent = Math.floor(fraction * 100)
      if (percent === shown) return
      shown = percent
      toast.loading(`${label}… ${percent}%`, { id, duration: Infinity })
    })

    stagedVersion = update.version
    offerRestart(update.version)
  } catch (err) {
    toast.error("Could not install the update", {
      id,
      description: message(err),
      duration: 8_000,
    })
    await update.dismiss()
  } finally {
    installInFlight = false
  }
}

/** Release notes are free-form markdown; one trimmed line is enough here. */
function summarize(update: DesktopUpdate): string {
  const note = update.notes
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const current = `You have ${update.currentVersion}.`
  return note ? `${current} ${note}` : current
}

function message(err: unknown) {
  return err instanceof Error && err.message ? err.message : undefined
}

/**
 * Mounted once in the root layout. Renders nothing: its only job is to hand the
 * startup check to an idle callback so it never competes with hydration.
 */
export function DesktopUpdater() {
  React.useEffect(() => {
    if (startupCheckStarted) return
    startupCheckStarted = true

    let idle = 0
    const timer = window.setTimeout(() => {
      const run = () => void checkForUpdates()
      if (typeof window.requestIdleCallback === "function") {
        idle = window.requestIdleCallback(run, { timeout: 10_000 })
      } else {
        run()
      }
    }, STARTUP_DELAY_MS)

    return () => {
      window.clearTimeout(timer)
      if (idle && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idle)
      }
      // A cancelled mount (React strict mode's double effect, a fast unmount)
      // should be able to schedule again.
      startupCheckStarted = false
    }
  }, [])

  return null
}
