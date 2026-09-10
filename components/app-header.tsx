"use client"

import { Copy, Minus, Square, X } from "lucide-react"
import Link from "next/link"
import * as React from "react"

import {
  hasNativeWindowControls,
  isDesktop,
  isMaximized,
  onMaximizedChange,
  windowAction,
} from "@/lib/desktop"
import { rememberDesktopShell } from "@/lib/theme/apply"
import { cn } from "@/lib/utils"

/**
 * The app's own window chrome. In the Tauri shell the window is frameless, so
 * this bar *is* the title bar: the whole strip is a drag region, a double click
 * on empty space toggles maximize, and — off macOS, where the traffic lights
 * are drawn by the system — it carries its own minimize / maximize / close.
 *
 * The bar is deliberately quiet: no mark, no wordmark, no chat title — those
 * live in the sidebar and the document title. It carries no state of its own
 * — a run's progress belongs above the turn it describes, a chat's working
 * folder above the composer that will use it. Pages put left-side extras
 * (a back link) in as children; `AppHeaderActions` holds the right-side
 * controls.
 *
 * Everything is slot-based (`AppHeaderActions`, `AppHeaderButton`) so the
 * chat page and the settings page share one implementation instead of two
 * near-copies.
 */

/* -------------------------------------------------------------------------- */
/* Desktop chrome                                                              */
/* -------------------------------------------------------------------------- */

const subscribe = () => () => {}

/** True only after hydration, so the shell probe never mismatches the server. */
function useHydrated() {
  return React.useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
}

type DesktopChrome = {
  /** Running inside the Tauri shell. */
  desktop: boolean
  /** macOS: the system draws the traffic lights over our header. */
  native: boolean
}

const BROWSER_CHROME: DesktopChrome = { desktop: false, native: false }

/** Resolved after hydration — `isDesktop()` reads a window global. */
export function useDesktopChrome(): DesktopChrome {
  const hydrated = useHydrated()
  return React.useMemo(
    () =>
      hydrated
        ? { desktop: isDesktop(), native: hasNativeWindowControls() }
        : BROWSER_CHROME,
    [hydrated]
  )
}

/* -------------------------------------------------------------------------- */
/* Slots                                                                       */
/* -------------------------------------------------------------------------- */

export function AppHeaderActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="app-header-actions"
      className={cn("ml-auto flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  )
}

/**
 * A 28px square for an icon on its own — `min-w-7` plus the padding is exactly
 * that around a 16px glyph — and a pill that grows for the ones that carry a
 * number beside it (the changed-file count, the token total).
 *
 * `min-w`, not `w`: a fixed `size-7` around an icon *and* a label is a box
 * whose content is wider than the box, and `justify-center` then spills it out
 * of both ends, over the buttons on either side. The header looked broken for
 * exactly that reason.
 */
const HEADER_BUTTON_CLASS =
  "inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 md:h-7 md:min-w-7 md:px-1.5 [&_svg]:size-4 [&_svg]:shrink-0"

export type AppHeaderButtonProps = React.ComponentProps<"button"> & {
  /** Accessible name; also the native tooltip. */
  label: string
  /** Renders a `next/link` instead of a button. */
  href?: string
  /** Trailing keyboard hint, shown from `lg` up. */
  hint?: React.ReactNode
}

export function AppHeaderButton({
  label,
  href,
  hint,
  className,
  children,
  ...props
}: AppHeaderButtonProps) {
  const body = (
    <>
      {children}
      {hint ? (
        <span className="hidden text-[11px] font-medium text-muted-foreground lg:inline">
          {hint}
        </span>
      ) : null}
    </>
  )
  const classes = cn(HEADER_BUTTON_CLASS, hint && "lg:px-2", className)

  if (href) {
    return (
      <Link href={href} aria-label={label} title={label} className={classes}>
        {body}
      </Link>
    )
  }

  return (
    <button type="button" aria-label={label} title={label} className={classes} {...props}>
      {body}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Window controls                                                             */
/* -------------------------------------------------------------------------- */

const WINDOW_BUTTON_CLASS =
  "inline-grid h-10 w-[42px] shrink-0 place-items-center rounded-none text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:-outline-offset-2 [&_svg]:size-3.5 [&_svg]:shrink-0"

function WindowControls() {
  const [maximized, setMaximized] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    void isMaximized().then((value) => {
      if (!cancelled) setMaximized(value)
    })
    void onMaximizedChange((value) => {
      if (!cancelled) setMaximized(value)
    }).then((off) => {
      if (cancelled) off()
      else unsubscribe = off
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  return (
    <div
      data-slot="window-controls"
      className="-mr-3 ml-2 flex h-10 shrink-0 items-stretch self-stretch sm:-mr-4"
    >
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void windowAction("minimize")}
        className={WINDOW_BUTTON_CLASS}
      >
        <Minus />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => void windowAction("toggle-maximize")}
        className={WINDOW_BUTTON_CLASS}
      >
        {maximized ? <Copy className="-scale-x-100" /> : <Square />}
      </button>
      <button
        type="button"
        aria-label="Close"
        title="Close"
        onClick={() => void windowAction("close")}
        className={cn(
          WINDOW_BUTTON_CLASS,
          "hover:bg-destructive hover:text-white"
        )}
      >
        <X />
      </button>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Header                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Placeholder the width of `WindowControls`, rendered server-side and until
 * hydration decides. It is `display:none` unless the pre-paint guard stamped
 * `data-desktop="1"` on <html> (see `lib/theme/apply.ts`), so a browser tab
 * pays nothing and the desktop shell stops shifting its whole header the
 * moment the client chunk lands.
 */
function WindowControlsReserve() {
  return (
    <div
      aria-hidden
      data-slot="window-controls-reserve"
      className="-mr-3 ml-2 h-10 w-[126px] shrink-0 self-stretch sm:-mr-4"
    />
  )
}

export type AppHeaderProps = React.ComponentProps<"header">

export function AppHeader({
  className,
  children,
  onDoubleClick,
  ...props
}: AppHeaderProps) {
  const hydrated = useHydrated()
  const { desktop, native } = useDesktopChrome()

  // Sticky enough for the next cold start to reserve the strip up front.
  React.useEffect(() => {
    if (hydrated) rememberDesktopShell(desktop)
  }, [desktop, hydrated])

  const handleDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    onDoubleClick?.(event)
    if (!desktop || event.defaultPrevented) return
    // Only empty bar area — never a control the user just double-clicked.
    const target = event.target as HTMLElement | null
    if (target?.closest("button, a, input, [role='button']")) return
    void windowAction("toggle-maximize")
  }

  return (
    <header
      data-slot="app-header"
      data-tauri-drag-region
      onDoubleClick={handleDoubleClick}
      className={cn(
        // No rule under the bar. It sits on the same surface as the
        // conversation, so a line here only draws a box around content that
        // is already obviously below it — and it is the first thing that
        // makes the window look busy.
        "flex h-10 w-full shrink-0 items-center gap-2 bg-background px-3 sm:gap-3 sm:px-4",
        desktop && "select-none",
        // Clear the macOS traffic lights.
        native && "pl-[78px]",
        className
      )}
      {...props}
    >
      {children}
      {desktop && !native ? <WindowControls /> : null}
      {hydrated ? null : <WindowControlsReserve />}
    </header>
  )
}
