"use client"

import { FileLock2, MoreHorizontal, X } from "lucide-react"
import * as React from "react"

import type { FileActionItem } from "@/components/ui/change-summary"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FileIcon } from "@/components/ui/file-icon"
import { cn } from "@/lib/utils"

/**
 * What the file panel shows when `GET /api/file` answers "that file is
 * binary".
 *
 * The vendored `FilePreview` renders text or a diff, and neither describes a
 * PNG, a `.wasm` or a compiled binary — its fallback would be the diff alone,
 * which is a claim about bytes nobody can read. So this stands in its place:
 * the same header shape, the same right-click and kebab actions, and one line
 * saying where the file can actually be opened.
 *
 * Deliberately not a wrapper around `FilePreview`: the panel body is the whole
 * point, and composing over a component that has no slot for one would mean
 * covering it.
 */
export function BinaryFilePanel({
  path,
  actions,
  onCopyPath,
  onClose,
  className,
}: {
  path: string
  /** Same array `FilePreview` is handed — `lib/file-actions`. */
  actions?: FileActionItem[]
  onCopyPath?: (path: string) => void
  onClose?: () => void
  className?: string
}) {
  const trimmed = path.replace(/[\\/]+$/, "")
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  const dir = cut > 0 ? trimmed.slice(0, cut + 1) : ""
  const name = trimmed.slice(cut + 1) || trimmed

  /** The first "Open in …" entry, so the note carries the verb it names. */
  const opener = actions?.find((action) => action.id.startsWith("open"))

  return (
    <div
      data-slot="binary-file"
      role="dialog"
      aria-label={path}
      className={cn(
        "flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground",
        className
      )}
    >
      <div
        data-slot="binary-file-header"
        className="flex h-10 shrink-0 items-center gap-2 border-b px-2.5"
      >
        <FileIcon path={path} size={14} />
        <button
          type="button"
          data-slot="binary-file-path"
          title="Copy path"
          onClick={() => onCopyPath?.(path)}
          className="flex min-w-0 flex-1 items-baseline gap-1 rounded-md text-left font-mono text-[12px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {dir ? (
            <span className="min-w-0 truncate text-muted-foreground">{dir}</span>
          ) : null}
          <span className="shrink-0 font-medium text-foreground">{name}</span>
        </button>
        {actions?.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-slot="binary-file-actions"
                aria-label="File actions"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3.5"
              >
                <MoreHorizontal />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {actions.map((action) => (
                <React.Fragment key={action.id}>
                  {action.separatorBefore ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    data-action={action.id}
                    variant={action.destructive ? "destructive" : "default"}
                    onSelect={() => action.onSelect(path)}
                    className="text-[12.5px]"
                  >
                    {action.icon}
                    {action.label}
                  </DropdownMenuItem>
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {onClose ? (
          <button
            type="button"
            data-slot="binary-file-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close file preview"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3.5"
          >
            <X />
          </button>
        ) : null}
      </div>

      <div
        data-slot="binary-file-body"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <FileLock2 aria-hidden className="size-6 text-muted-foreground" />
        <p className="text-[12.5px] text-muted-foreground">
          Binary file — open it in your editor.
        </p>
        {opener ? (
          <button
            type="button"
            onClick={() => opener.onSelect(path)}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3.5"
          >
            {opener.icon}
            {opener.label}
          </button>
        ) : null}
      </div>
    </div>
  )
}
