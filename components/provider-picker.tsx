"use client"

import { Check, ChevronDown, Plug } from "lucide-react"
import * as React from "react"

import { ProviderLogo, hasProviderLogo } from "@/components/provider-logo"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ProviderInfo } from "@/lib/providers/types"
import { cn } from "@/lib/utils"

/**
 * Mirrored from `lib/providers/acp` (server-only, so it cannot be imported
 * here): configured ACP agents live under `acp:<key>` ids.
 */
const ACP_PROVIDER_PREFIX = "acp:"

/** Provider ids (or ACP agent keys) whose brand slug is not the id itself. */
const LOGO_SLUGS: Record<string, string> = {
  cursorAgent: "cursor",
  dsh: "deepseek",
}

/** Brand-mark slug for a provider id; empty when no mark exists. */
function providerLogoSlug(providerId: string): string {
  const key = providerId.startsWith(ACP_PROVIDER_PREFIX)
    ? providerId.slice(ACP_PROVIDER_PREFIX.length)
    : providerId
  const slug = LOGO_SLUGS[key] ?? key
  return hasProviderLogo(slug) ? slug : ""
}

export type ProviderPickerProps = {
  providers: ProviderInfo[]
  value: string
  onChange: (id: string) => void
  /** Windows-only: locate a missing harness binary via a native file dialog. */
  onConfigure?: (id: string) => void
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
  onConfigure,
  className,
}: ProviderPickerProps) {
  const current = providers.find((provider) => provider.id === value)
  const currentSlug = current ? providerLogoSlug(current.id) : ""
  const [open, setOpen] = React.useState(false)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="provider-picker-trigger"
          title="Change provider"
          /* The name is hidden on a narrow composer, so it is named here too. */
          aria-label={current ? `Provider: ${current.name}` : "Change provider"}
          disabled={providers.length === 0}
          className={cn(
            "group inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-muted data-[state=open]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
            className
          )}
        >
          {currentSlug ? (
            <ProviderLogo slug={currentSlug} className="size-3.5" />
          ) : (
            <Plug className="size-3.5" />
          )}
          <span className="hidden truncate sm:inline">
            {current?.name ?? "Provider"}
          </span>
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
        className="w-[min(22rem,calc(100vw-1.5rem))]"
      >
        <DropdownMenuLabel className="text-[11px] tracking-wide text-muted-foreground uppercase">
          Providers
        </DropdownMenuLabel>
        {providers.map((provider) => {
          const showConfigure =
            Boolean(onConfigure) &&
            !provider.available &&
            Boolean(provider.configureBinary)
          const slug = providerLogoSlug(provider.id)

          return (
            <div
              key={provider.id}
              className="flex items-start gap-0.5"
            >
              <DropdownMenuItem
                data-slot="provider-picker-item"
                disabled={!provider.available}
                onSelect={() => onChange(provider.id)}
                className="min-w-0 flex-1 items-start gap-2.5 py-2"
              >
                <span
                  className={cn(
                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                    provider.available ? "bg-primary" : "bg-muted-foreground/40"
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {slug ? (
                      <ProviderLogo slug={slug} className="size-3.5" />
                    ) : null}
                    <span className="min-w-0 truncate text-[13px] text-foreground">
                      {provider.name}
                    </span>
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
              {showConfigure ? (
                <button
                  type="button"
                  data-slot="provider-configure"
                  title={`Locate the ${provider.name} binary`}
                  className="mt-1.5 mr-1 shrink-0 rounded-md px-1.5 py-1 text-[11px] font-medium text-primary outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setOpen(false)
                    onConfigure?.(provider.id)
                  }}
                >
                  Configure
                </button>
              ) : null}
            </div>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
