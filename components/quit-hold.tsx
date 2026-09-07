"use client"

import * as React from "react"

import { isDesktop, onQuitRequested, quit, setQuitHoldArmed } from "@/lib/desktop"

// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * "Hold ⌘Q to quit", for the one case where quitting costs something.
 *
 * A coding agent's turn is not a document with unsaved changes: it is a
 * subprocess writing to the user's checkout, and killing the app mid-turn
 * leaves the work half-done with no record of where it stopped. ⌘Q is also
 * one key away from ⌘W and ⌘A, which is how it gets pressed by accident.
 *
 * So the quit is *held* rather than confirmed: no dialog to dismiss, no
 * setting to find, nothing at all when nothing is running. The shell is only
 * asked to intercept the close while a turn is in flight (`setQuitHoldArmed`),
 * which is what keeps the failure mode benign — a page that never loads, or a
 * bug in this file, leaves the app quitting exactly as it always did.
 *
 * Two ways through it, because the two platforms deliver the keystroke
 * differently. On macOS ⌘Q is swallowed by the application menu and reaches
 * this page only as the shell's `quit-requested` event, once per press and
 * once per key *repeat* — so a hold is a run of events, and a double press is
 * two events separated by a real gap. Everywhere else the webview sees the
 * keystroke itself, and a hold is a keydown that is still down 1.2 seconds
 * later, whether or not the platform repeats it.
 */

/** How long ⌘Q must be held. Long enough to be deliberate, short enough to feel like a gesture. */
const HOLD_MS = 1_200
/** Two presses inside this window are the other way to say yes. */
const DOUBLE_PRESS_MS = 500
/** Signals closer together than this are one key held down, not two presses. */
const REPEAT_GAP_MS = 250
/** The overlay stays this long after the last signal, then fades out of the tree. */
const LINGER_MS = 1_200

/* -------------------------------------------------------------------------- */
/* How many chats are running                                                  */
/* -------------------------------------------------------------------------- */

let runningChats = 0
const subscribers = new Set<() => void>()

/**
 * Tells the overlay how many chats are mid-turn.
 *
 * A module-level store rather than a prop or a context, for the same reason
 * the header is mounted where it is: this component lives in the root layout,
 * above the chat page and outside every provider it owns, and the count is one
 * number that changes a few times a minute. The chat page sets it from
 * wherever it already knows the answer (`app/hooks/use-attention.ts` counts
 * running turns for the dock badge; `use-turn-runner` starts and ends them).
 */
export function setRunningChats(count: number) {
  const next = Math.max(0, Math.trunc(count))
  if (next === runningChats) return
  runningChats = next
  for (const notify of subscribers) notify()
}

/** What the store currently holds — for a caller that needs to read it back. */
export function runningChatCount() {
  return runningChats
}

function subscribe(notify: () => void) {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

function useRunningChats() {
  return React.useSyncExternalStore(
    subscribe,
    () => runningChats,
    // Nothing runs during a server render, and the overlay is invisible until
    // a keystroke anyway.
    () => 0
  )
}

/* -------------------------------------------------------------------------- */
/* The overlay                                                                 */
/* -------------------------------------------------------------------------- */

function quitShortcut() {
  if (typeof navigator === "undefined") return "Ctrl+Q"
  const platform = `${navigator.platform} ${navigator.userAgent}`
  return /mac|iphone|ipad/i.test(platform) ? "⌘Q" : "Ctrl+Q"
}

export function QuitHold() {
  const running = useRunningChats()
  const [heldSince, setHeldSince] = React.useState<number | null>(null)
  const [progress, setProgress] = React.useState(0)

  // Everything the signal handler reads lives in refs: it is subscribed once,
  // from an effect, and must not be re-subscribed every time the count changes.
  const runningRef = React.useRef(running)
  const burstStart = React.useRef<number | null>(null)
  const lastSignal = React.useRef(0)
  const lastBurstEnd = React.useRef(0)
  const holdTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  const lingerTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )

  React.useEffect(() => {
    runningRef.current = running
  }, [running])

  const endBurst = React.useCallback(() => {
    clearTimeout(holdTimer.current)
    holdTimer.current = undefined
    if (burstStart.current !== null) lastBurstEnd.current = Date.now()
    burstStart.current = null
  }, [])

  const finish = React.useCallback(() => {
    endBurst()
    clearTimeout(lingerTimer.current)
    setHeldSince(null)
    void quit()
  }, [endBurst])

  /**
   * One "the user is asking to quit" signal, from either delivery path.
   *
   * The whole state machine is here: a signal that follows the previous one
   * closely is the same press repeating (it advances the hold), and one that
   * follows a gap is a new press (which quits when the press before it was
   * inside the double-press window).
   */
  const signal = React.useCallback(() => {
    if (runningRef.current === 0) {
      finish()
      return
    }
    const now = Date.now()
    const previousSignal = lastSignal.current
    const active = burstStart.current !== null
    const repeating = active && now - previousSignal <= REPEAT_GAP_MS
    lastSignal.current = now

    if (repeating) {
      if (now - (burstStart.current ?? now) >= HOLD_MS) {
        finish()
        return
      }
    } else {
      // A press that follows another one closely enough is the second half of
      // a double press. "Closely enough" is measured from the previous press's
      // *last* signal, because a burst that is still open has not recorded an
      // end yet.
      //
      // A slow key repeat can land here and be read as a second press, which
      // quits at half a second instead of at 1.2. That is the right way round
      // to be wrong: both readings require the user to be pressing ⌘Q twice or
      // holding it down, and the accident this guards against — one stray press
      // — produces exactly one signal and never reaches this branch.
      const previousEnd = active ? previousSignal : lastBurstEnd.current
      endBurst()
      if (previousEnd && now - previousEnd <= DOUBLE_PRESS_MS) {
        finish()
        return
      }
      burstStart.current = now
      setHeldSince(now)
      setProgress(0)
    }

    // The overlay follows the keystrokes, not a fixed duration: it goes away
    // shortly after the user stops asking.
    clearTimeout(lingerTimer.current)
    lingerTimer.current = setTimeout(() => {
      endBurst()
      setHeldSince(null)
    }, LINGER_MS)
  }, [endBurst, finish])

  const signalRef = React.useRef(signal)
  React.useEffect(() => {
    signalRef.current = signal
  }, [signal])

  /* The shell's interception, armed only while something is running. */
  React.useEffect(() => {
    if (!isDesktop()) return
    void setQuitHoldArmed(running > 0)
  }, [running])

  React.useEffect(() => {
    if (!isDesktop()) return
    // Whatever else happens, this page stops asking the shell to hold the
    // window open the moment it goes away.
    return () => {
      void setQuitHoldArmed(false)
    }
  }, [])

  /* macOS: ⌘Q never reaches the webview, so the shell forwards it. */
  React.useEffect(() => {
    if (!isDesktop()) return
    let unsubscribe = () => {}
    let cancelled = false
    void onQuitRequested(() => signalRef.current()).then((off) => {
      if (cancelled) off()
      else unsubscribe = off
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  /*
   * Everywhere else: the keystroke itself. A real hold rather than a run of
   * repeats — the key is down or it is not — so this path works with keyboard
   * repeat switched off, which the forwarded one cannot.
   */
  React.useEffect(() => {
    if (!isDesktop()) return
    const down = (event: KeyboardEvent) => {
      if (event.key?.toLowerCase() !== "q") return
      if (!event.metaKey && !event.ctrlKey) return
      if (runningRef.current > 0) event.preventDefault()
      signalRef.current()
      if (!event.repeat && runningRef.current > 0) {
        clearTimeout(holdTimer.current)
        holdTimer.current = setTimeout(() => {
          if (burstStart.current !== null) finish()
        }, HOLD_MS)
      }
    }
    const up = (event: KeyboardEvent) => {
      if (event.key?.toLowerCase() !== "q") return
      clearTimeout(holdTimer.current)
      holdTimer.current = undefined
      // Releasing early is not a cancellation: it opens the double-press window.
      if (burstStart.current !== null) {
        lastBurstEnd.current = Date.now()
        burstStart.current = null
      }
    }
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
    }
  }, [finish])

  /* The bar, driven off the same clock the decision uses. */
  React.useEffect(() => {
    if (heldSince === null) return
    let frame = 0
    const tick = () => {
      const start = burstStart.current ?? heldSince
      setProgress(Math.min(1, (Date.now() - start) / HOLD_MS))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [heldSince])

  React.useEffect(
    () => () => {
      clearTimeout(holdTimer.current)
      clearTimeout(lingerTimer.current)
    },
    []
  )

  if (heldSince === null || running === 0) return null

  return (
    <div
      data-slot="quit-hold"
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[22%] z-100 flex justify-center px-4"
    >
      <div className="bg-popover/95 text-popover-foreground border-border w-full max-w-xs rounded-lg border p-4 shadow-lg backdrop-blur-sm">
        <p className="text-[13px] font-medium">
          Hold {quitShortcut()} to quit
        </p>
        <p className="text-muted-foreground mt-0.5 text-[11.5px]">
          {running === 1
            ? "1 chat is still running"
            : `${running} chats are still running`}
        </p>
        <div
          data-slot="quit-hold-progress"
          className="bg-muted mt-2.5 h-1 overflow-hidden rounded-full"
        >
          <div
            className="bg-primary h-full rounded-full"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>
    </div>
  )
}
