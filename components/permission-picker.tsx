"use client"

import {
  Check,
  ChevronDown,
  Eye,
  FilePen,
  ListTodo,
  ShieldOff,
} from "lucide-react"
import * as React from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { PermissionMode } from "@/lib/providers/types"
import { cn } from "@/lib/utils"

/**
 * How each mode is named in the composer. Kept here rather than in the
 * provider layer: the vocabulary is the same for every harness, only the
 * subset a harness can actually enforce differs.
 */
const PERMISSION_LABELS: Record<
  PermissionMode,
  { name: string; description: string; icon: typeof Eye }
> = {
  "read-only": {
    name: "Read-only",
    description: "Runs read-only tools, refuses the rest",
    icon: Eye,
  },
  plan: {
    name: "Plan",
    description: "Reads and proposes a plan, changes nothing",
    icon: ListTodo,
  },
  edits: {
    name: "Edits",
    description: "Writes and runs inside the workspace",
    icon: FilePen,
  },
  full: {
    name: "Full access",
    description: "Any file, any command, no prompts",
    icon: ShieldOff,
  },
}

export type PermissionPickerProps = {
  /** The modes this harness can enforce, in the order it published them. */
  modes: PermissionMode[]
  value: PermissionMode
  onChange: (mode: PermissionMode) => void
  className?: string
}

/**
 * Per-chat permission policy for the composer. Only rendered for a harness
 * that publishes `capabilities.permissionModes`, and only its own modes are
 * offered — a picker that can express what the backend cannot enforce would
 * be a promise the run does not keep.
 */
export const PermissionPicker = React.memo(function PermissionPicker({
  modes,
  value,
  onChange,
  className,
}: PermissionPickerProps) {
  const current = PERMISSION_LABELS[value] ?? PERMISSION_LABELS.full
  const CurrentIcon = current.icon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="permission-picker-trigger"
          title="Change what the agent may do"
          /* The name is hidden on a narrow composer, so it is named here too. */
          aria-label={`Permissions: ${current.name}`}
          className={cn(
            "group inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-muted data-[state=open]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
            className
          )}
        >
          <CurrentIcon className="size-3.5" />
          <span className="hidden truncate sm:inline">{current.name}</span>
          <ChevronDown className="size-3 opacity-60 transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-slot="permission-picker-content"
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="w-[min(18rem,calc(100vw-1.5rem))]"
      >
        <DropdownMenuLabel className="text-[11px] tracking-wide text-muted-foreground uppercase">
          Permissions
        </DropdownMenuLabel>
        {modes.map((mode) => {
          const meta = PERMISSION_LABELS[mode]
          if (!meta) return null
          const ModeIcon = meta.icon
          return (
            <DropdownMenuItem
              key={mode}
              data-slot="permission-picker-item"
              role="menuitemradio"
              aria-checked={mode === value}
              onSelect={() => onChange(mode)}
              className="items-start gap-2.5 py-2"
            >
              <ModeIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-foreground">
                  {meta.name}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {meta.description}
                </span>
              </span>
              {mode === value ? (
                <Check className="mt-0.5 size-3.5 shrink-0 !text-primary" />
              ) : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
