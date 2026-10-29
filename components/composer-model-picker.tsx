"use client"

import { ChevronDown, LoaderCircle, RotateCcw, Zap } from "lucide-react"
import * as React from "react"
import { ModelPicker, type ModelPickerProps } from "@/components/ui/model-picker"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/** App composition of the registry picker: model and reasoning in one card. */
export function ComposerModelPicker({ loading, onRefresh, ...props }: ModelPickerProps & {
  loading: boolean
  onRefresh: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const current = props.options.find((option) => option.id === props.value)
  const efforts = props.efforts || []
  const index = Math.max(0, efforts.findIndex((option) => option.id === props.effort))
  const chosen = efforts[index]
  const trigger = "flex h-9 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-slot="model-picker-trigger" aria-label="Choose model and reasoning" className={cn(trigger, props.className)}>
          {loading ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : current?.icon}
          <span className="truncate">{current?.name ?? (loading ? "Loading models…" : "Choose model")}</span>
          {chosen ? <span data-composer-label className="shrink-0 opacity-60">{chosen.label}</span> : null}
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" data-slot="composer-model-card" className="w-[min(19rem,calc((100vw-1.5rem)/var(--ui-scale,1)))] rounded-2xl p-3">
        <div className="flex items-start justify-between gap-2">
          <Zap aria-hidden className="mt-1 size-3.5 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col items-center">
            {chosen ? <span className="text-[15px] font-medium text-primary">{chosen.label}</span> : null}
            <ModelPicker {...props} efforts={false} placeholder={loading ? "Loading models…" : "Choose model"} className="max-w-full text-[11px]" />
          </div>
          <button type="button" aria-label="Refresh models" title="Refresh models" disabled={loading} onClick={onRefresh} className="rounded-md p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            <RotateCcw className={cn("size-3.5", loading && "animate-spin")} />
          </button>
        </div>
        {efforts.length > 1 ? <div className="px-1 pt-4 pb-1">
          <input type="range" aria-label="Reasoning effort" aria-valuetext={chosen?.label} min={0} max={efforts.length - 1} step={1} value={index} onChange={(event) => props.onEffortChange?.(efforts[Number(event.target.value)].id)} style={{ background: `linear-gradient(to right, var(--primary) ${index / (efforts.length - 1) * 100}%, var(--muted) ${index / (efforts.length - 1) * 100}%)` }} className="h-2 w-full cursor-pointer appearance-none rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-border [&::-webkit-slider-thumb]:bg-background [&::-webkit-slider-thumb]:shadow-sm [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-border [&::-moz-range-thumb]:bg-background" />
          <div aria-hidden className="mt-2 flex justify-between text-[10px] text-muted-foreground"><span>{efforts[0].label}</span><span>{efforts.at(-1)?.label}</span></div>
        </div> : null}
        {!loading && props.options.length === 0 ? <p role="status" className="mt-2 text-center text-[12px] text-muted-foreground">No models available. Refresh to retry.</p> : null}
      </PopoverContent>
    </Popover>
  )
}
