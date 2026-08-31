"use client"

import { Check, ChevronDown, Plug } from "lucide-react"
import * as React from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ProviderInfo } from "@/lib/providers/types"
import { cn } from "@/lib/utils"

export type ProviderPickerProps = {
  providers: ProviderInfo[]
  value: string
  onChange: (id: string) => void
  className?: string
}

/**
 * Compact backend switcher for the composer. Unavailable providers stay in the
 * list but are disabled and explain themselves, so "why can't I pick Ollama?"
 * is answered in place instead of in the settings page.
 */
export const ProviderPicker = React.memo(function ProviderPicker({
  providers,
  value,
  onChange,
  className,
}: ProviderPickerProps) {
  const current = providers.find((provider) => provider.id === value)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="provider-picker-trigger"
          title="Change provider"
          disabled={providers.length === 0}
          className={cn(
            "group inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-muted data-[state=open]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
            className
          )}
        >
          <Plug className="size-3.5" />
          <span className="truncate">{current?.name ?? "Provider"}</span>
          {current && !current.available ? (
            <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
          ) : null}
          <ChevronDown className="size-3 opacity-60 transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-slot="provider-picker-content"
        align="start"
        side="top"
        sideOffset={8}
        className="w-[min(19rem,calc(100vw-1.5rem))]"
      >
        <DropdownMenuLabel className="text-[11px] tracking-wide text-muted-foreground uppercase">
          Providers
        </DropdownMenuLabel>
        {providers.map((provider) => (
          <DropdownMenuItem
            key={provider.id}
            data-slot="provider-picker-item"
            disabled={!provider.available}
            onSelect={() => onChange(provider.id)}
            className="items-start gap-2.5 py-2"
          >
            <span
              className={cn(
                "mt-1.5 size-1.5 shrink-0 rounded-full",
                provider.available ? "bg-primary" : "bg-muted-foreground/40"
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-foreground">
                {provider.name}
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {provider.available
                  ? provider.description
                  : (provider.unavailableReason ?? "Unavailable")}
              </span>
            </span>
            {provider.id === value ? (
              <Check className="mt-0.5 size-3.5 shrink-0 !text-primary" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
