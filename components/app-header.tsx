"use client"

import { Copy, Minus, Square, X } from "lucide-react"
import Link from "next/link"
import * as React from "react"

import {
  GenerationStatus,
  type GenerationStage,
} from "@/components/ui/generation-status"
import {
  hasNativeWindowControls,
  isDesktop,
  isMaximized,
  onMaximizedChange,
  windowAction,
} from "@/lib/desktop"
import { cn } from "@/lib/utils"

/**
 * The app's own window chrome. In the Tauri shell the window is frameless, so
 * this bar *is* the title bar: the whole strip is a drag region, a double click
 * on empty space toggles maximize, and — off macOS, where the traffic lights
 * are drawn by the system — it carries its own minimize / maximize / close.
 *
 * Everything is slot-based (`AppHeaderBrand`, `AppHeaderTitle`,
 * `AppHeaderActions`, `AppHeaderButton`) so the chat page and the settings page
 * share one implementation instead of two near-copies.
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
/* Brand mark                                                                  */
/* -------------------------------------------------------------------------- */

/** The app icon, simplified for 24px: dark tile, speech bubble, blue caret. */
export function AppMark({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="Agent UI"
      data-slot="app-mark"
      className={cn("size-6 shrink-0 text-foreground", className)}
      {...props}
    >
      <rect width="24" height="24" rx="6.5" fill="currentColor" />
      <path
        d="M8.5 5.5H15.5A3.5 3.5 0 0 1 19 9V13.5A3.5 3.5 0 0 1 15.5 17H11.6L8.2 20.1V16.9A3.5 3.5 0 0 1 5 13.5V9A3.5 3.5 0 0 1 8.5 5.5Z"
        fill="none"
        stroke="var(--background)"
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M9.9 9.1 12.5 11.3 9.9 13.5"
        fill="none"
        stroke="var(--primary)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/* Slots                                                                       */
/* -------------------------------------------------------------------------- */

export type AppHeaderBrandProps = React.ComponentProps<"span"> & {
  /** Wordmark next to the mark; pass `null` for the mark alone. */
  label?: React.ReactNode
}

export function AppHeaderBrand({
  label = "Agent UI",
  className,
  children,
  ...props
}: AppHeaderBrandProps) {
  return (
    <span
      data-slot="app-header-brand"
      data-tauri-drag-region
      className={cn("flex shrink-0 items-center gap-2", className)}
      {...props}
    >
      <AppMark />
      {label != null ? (
        <span
          data-tauri-drag-region
          className="text-[13px] font-semibold tracking-tight text-foreground"
        >
          {label}
        </span>
      ) : null}
      {children}
    </span>
  )
}

export type AppHeaderTitleProps = Omit<
  React.ComponentProps<"div">,
  "title"
> & {
  title?: React.ReactNode
  /** Shows the live spinner + stage word next to the title. */
  generating?: boolean
  stage?: GenerationStage
  /** Hairline before the title, separating it from the brand. */
  divider?: boolean
}

export function AppHeaderTitle({
  title,
  generating = false,
  stage = "thinking",
  divider = true,
  className,
  children,
  ...props
}: AppHeaderTitleProps) {
  return (
    <div
      data-slot="app-header-title"
      data-tauri-drag-region
      className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
      {...props}
    >
      {divider ? (
        <span
          aria-hidden
          data-tauri-drag-region
          className="hidden h-4 w-px shrink-0 bg-border sm:block"
        />
      ) : null}
      {title != null ? (
        <span
          data-slot="app-header-title-text"
          data-tauri-drag-region
          title={typeof title === "string" ? title : undefined}
          className="min-w-0 truncate text-[13px] text-muted-foreground"
        >
          {title}
        </span>
      ) : null}
      {generating ? (
        <GenerationStatus
          stage={stage}
          size={13}
          className="shrink-0 text-[12px]"
        />
      ) : null}
      {children}
    </div>
  )
}

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

const HEADER_BUTTON_CLASS =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0"

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
  const classes = cn(
    HEADER_BUTTON_CLASS,
    hint && "lg:w-auto lg:gap-1.5 lg:px-2",
    className
  )

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
  "inline-grid h-12 w-[46px] shrink-0 place-items-center rounded-none text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:-outline-offset-2 [&_svg]:size-3.5 [&_svg]:shrink-0"

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
      className="-mr-3 ml-2 flex h-12 shrink-0 items-stretch self-stretch border-l pl-2 sm:-mr-4"
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

export type AppHeaderProps = React.ComponentProps<"header">

export function AppHeader({
  className,
  children,
  onDoubleClick,
  ...props
}: AppHeaderProps) {
  const { desktop, native } = useDesktopChrome()

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
        "flex h-12 w-full shrink-0 items-center gap-2 border-b bg-background px-3 sm:gap-3 sm:px-4",
        desktop && "select-none",
        // Clear the macOS traffic lights.
        native && "pl-[78px]",
        className
      )}
      {...props}
    >
      {children}
      {desktop && !native ? <WindowControls /> : null}
    </header>
  )
}
