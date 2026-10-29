"use client"

import { X } from "lucide-react"
import * as React from "react"
import { snoozePresets } from "@/lib/snooze"

/** Opened from a chat's context menu, keeping the sidebar row clear. */
export function SnoozeChatDialog({ title, onClose, onSnooze }: {
  title: string
  onClose: () => void
  onSnooze: (until: number) => void
}) {
  const dialog = React.useRef<HTMLDialogElement>(null)
  const [presets] = React.useState(() => snoozePresets())
  React.useEffect(() => {
    const previous = document.activeElement
    dialog.current?.showModal()
    return () => { if (previous instanceof HTMLElement) previous.focus() }
  }, [])
  return <dialog ref={dialog} aria-labelledby="snooze-title" onCancel={onClose} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose() } }} className="fixed inset-0 m-auto w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-xl backdrop:bg-black/35">
    <div className="flex items-center justify-between gap-2 px-2 pb-2"><h2 id="snooze-title" className="truncate text-[14px] font-semibold">Snooze {title}</h2><button type="button" aria-label="Close snooze" onClick={onClose} className="rounded p-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" /></button></div>
    {presets.map((preset) => <button type="button" key={preset.id} data-slot="snooze-preset" onClick={() => { onSnooze(preset.until); onClose() }} className="flex w-full justify-between gap-4 rounded-lg px-3 py-3 text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span>{preset.label}</span><span className="text-muted-foreground">{preset.when}</span></button>)}
  </dialog>
}
