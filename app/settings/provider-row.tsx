"use client"

import * as React from "react"
import { Bot, ChevronRight, Copy, ExternalLink, RotateCw } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { HarnessLogo, SourceLogo } from "@/components/provider-logo"
import { Switch } from "@/components/ui/switch"
import { harnessBrand, sourceBrand } from "@/lib/model-brand"
import { cn } from "@/lib/utils"

/** App-local composition: the registry's generic settings primitives stay untouched. */
export function ProviderRow({
  id,
  name,
  source = false,
  enabled,
  onEnabledChange,
  status,
  onRefresh,
  refreshing = false,
  disabled = false,
  defaultOpen = false,
  children,
}: {
  id: string
  name: string
  source?: boolean
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  status?: React.ReactNode
  onRefresh?: () => void
  refreshing?: boolean
  disabled?: boolean
  defaultOpen?: boolean
  children?: React.ReactNode
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const panelId = React.useId()
  const hasBrand = source ? sourceBrand(id) : harnessBrand(id, name)
  const title = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background">
        {hasBrand ? (
          source ? (
            <SourceLogo source={id} className="size-[18px]" />
          ) : (
            <HarnessLogo providerId={id} name={name} className="size-[18px]" />
          )
        ) : (
          <Bot className="size-[18px] text-muted-foreground" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
        {name}
      </span>
      {children ? (
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
      ) : null}
    </>
  )

  return (
    <div data-slot="provider-row" data-provider-id={id}>
      <div className="flex min-h-16 items-center gap-2 px-4 sm:px-5">
        {children ? (
          <button
            type="button"
            aria-label={`Configure ${name}`}
            aria-expanded={open}
            aria-controls={panelId}
            disabled={disabled}
            onClick={() => setOpen((value) => !value)}
            className="-ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md p-1 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {title}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">{title}</div>
        )}
        <div aria-live="polite" className="shrink-0">
          {status}
        </div>
        {onRefresh ? (
          <RefreshButton
            name={name}
            onClick={onRefresh}
            busy={refreshing}
            disabled={disabled || !enabled}
          />
        ) : null}
        <Switch
          aria-label={`Enable ${name}`}
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onEnabledChange}
        />
      </div>
      {children ? (
        <div
          id={panelId}
          hidden={!open}
          data-slot="provider-details"
          className="border-t border-border/50 bg-muted/15 px-4 py-4 sm:px-5"
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

export function RefreshButton({
  name,
  onClick,
  busy,
  disabled,
}: {
  name: string
  onClick: () => void
  busy: boolean
  disabled?: boolean
}) {
  const label = `Refresh ${name}`
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-busy={busy}
      disabled={disabled || busy}
      onClick={onClick}
      className="size-8 shrink-0 text-muted-foreground"
    >
      <RotateCw
        aria-hidden="true"
        className={busy ? "animate-spin" : undefined}
      />
    </Button>
  )
}

export function ProviderField({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: React.ReactElement<{ id?: string }>
}) {
  const generatedId = React.useId()
  const id = htmlFor ?? generatedId
  return (
    <div className="grid min-w-0 gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center sm:gap-3">
      <label htmlFor={id} className="text-[12px] text-muted-foreground">
        {label}
      </label>
      {htmlFor ? children : React.cloneElement(children, { id })}
    </div>
  )
}

export function SetupCommand({ command }: { command: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border bg-background py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11.5px]">
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Copy ${command}`}
        title="Copy command"
        className="size-8 shrink-0"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command)
            toast.success("Command copied.")
          } catch {
            toast.error("Couldn't copy command.")
          }
        }}
      >
        <Copy aria-hidden="true" />
      </Button>
    </div>
  )
}

export function SetupLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex w-fit items-center gap-1 text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ExternalLink aria-hidden="true" className="size-3" />
    </a>
  )
}
