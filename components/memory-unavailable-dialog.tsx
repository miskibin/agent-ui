"use client"

import * as React from "react"
import { BrainCircuit, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Said once, when the app opens with memory on and no Ollama to run it on —
 * after the app has already tried to start one (`/api/memory/status`).
 *
 * A dialog rather than a toast because it changes what every answer in this
 * session is built from: the user turned memory on, and a red corner toast
 * that fades is how that fact used to get lost. It is also the only place the
 * outage is said; the per-turn update then stays silent instead of failing
 * after every answer.
 *
 * Hand-rolled like `import-dialog.tsx` — a fixed overlay with Escape and focus
 * handled here — rather than a Radix dialog the vendored set does not ship.
 */
export function MemoryUnavailableDialog({
  open,
  baseUrl,
  retrying,
  stillDown,
  onRetry,
  onClose,
  onOpenSettings,
}: {
  open: boolean
  baseUrl: string
  retrying: boolean
  /** A retry ran and Ollama still did not answer. */
  stillDown: boolean
  onRetry: () => void
  onClose: () => void
  onOpenSettings: () => void
}) {
  const closeRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      data-slot="memory-unavailable-dialog"
      className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[18vh]"
    >
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px] duration-150 animate-in fade-in-0 motion-reduce:animate-none"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-unavailable-title"
        aria-describedby="memory-unavailable-body"
        className={cn(
          "relative flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-3 rounded-lg border bg-popover p-4 shadow-lg",
          "duration-150 animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none"
        )}
      >
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <BrainCircuit className="size-4 text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="memory-unavailable-title" className="text-[13px] font-medium">
              Memory is off for now
            </h2>
            <div
              id="memory-unavailable-body"
              className="mt-1 space-y-1.5 text-[12px] leading-relaxed text-muted-foreground"
            >
              <p>
                Memory runs on Ollama, and there is no Ollama server at{" "}
                <span className="font-mono text-[11.5px] text-foreground">
                  {baseUrl || "an unset URL"}
                </span>{" "}
                — starting one didn&apos;t work either. Chats work as usual;
                they just won&apos;t recall or learn your preferences.
              </p>
              <p>
                Start it with{" "}
                <code className="rounded bg-muted px-1 font-mono text-[11.5px]">
                  ollama serve
                </code>{" "}
                (or install it from ollama.com) and memory comes back on by
                itself.
              </p>
              {stillDown ? (
                <p data-slot="memory-unavailable-retry" className="text-foreground">
                  Still no answer from Ollama.
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onOpenSettings}
            className="text-[12.5px]"
          >
            Memory settings
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={retrying}
            onClick={onRetry}
            className="ml-auto text-[12.5px]"
          >
            <RefreshCw className={cn(retrying && "animate-spin")} />
            Try again
          </Button>
          <Button
            ref={closeRef}
            type="button"
            size="sm"
            onClick={onClose}
            className="text-[12.5px]"
          >
            Continue without memory
          </Button>
        </div>
      </div>
    </div>
  )
}
