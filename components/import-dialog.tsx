"use client"

import { Check, Download, FolderGit2, Loader2, RefreshCw } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import * as api from "@/lib/api-client"
import { relativeTime } from "@/lib/chat-helpers"
import type { ImportProject, ImportProvider } from "@/lib/import/types"
import { cn } from "@/lib/utils"

/**
 * "Import history" — the folders Claude Code and Codex have already run in,
 * with a checkbox each.
 *
 * Deliberately not a Radix dialog, for the same reason the command palette is
 * not: a fixed overlay is enough, and the chat page's critical path stays free
 * of another portal library. The scan behind it reads two CLI home directories
 * and is the one slow thing here, so it runs when the dialog opens rather than
 * on a keystroke, and its result is kept until the dialog is closed.
 *
 * What the picker does *not* do is decide anything on the user's behalf: a
 * folder with a hundred conversations in it is offered exactly like one with
 * two, and nothing is imported until Import is pressed.
 */

export type ImportDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after a successful import, so the host can reload the sidebar. */
  onImported?: (result: { imported: number; skipped: number }) => void
}

/** A project row's identity — one folder can appear under both CLIs. */
function rowKey(project: ImportProject) {
  return `${project.provider} ${project.cwd}`
}

const PROVIDER_LABEL: Record<ImportProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
}

export function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: ImportDialogProps) {
  const [projects, setProjects] = React.useState<ImportProject[] | null>(null)
  const [truncated, setTruncated] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [scanning, setScanning] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const [scanToken, setScanToken] = React.useState(0)
  /**
   * When the scan landed. Every "last active" label is relative to it rather
   * than to a clock read during render — a render has to be pure, and a row
   * that says "3h" must not quietly become "4h" because something else
   * re-rendered the dialog.
   */
  const [scannedAt, setScannedAt] = React.useState(0)

  const close = React.useCallback(() => onOpenChange(false), [onOpenChange])

  // Escape closes, exactly as it does in the palette.
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, close])

  // Hand focus back to whatever opened the dialog.
  React.useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [open])

  // One scan per opening (and per press of Rescan). The abort matters: closing
  // the dialog mid-scan must not leave a state write pointing at a gone view.
  React.useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    // Deferred: a synchronous setState in an effect body is a cascading
    // render, and this one only has to land before the fetch does.
    queueMicrotask(() => {
      if (!controller.signal.aborted) setScanning(true)
    })
    api
      .scanImports(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setProjects(result.projects)
        setTruncated(result.truncated === true)
        setScannedAt(Date.now())
        setScanning(false)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setProjects([])
        setScanning(false)
        toast.error(
          error instanceof Error
            ? error.message
            : "Couldn't read the CLIs' history."
        )
      })
    return () => {
      controller.abort()
      // Closing throws the scan away: the CLIs' history moves on without us,
      // and a stale list is worse than the second of skeleton on reopening.
      setProjects(null)
      setSelected(new Set())
    }
  }, [open, scanToken])

  const toggle = React.useCallback((project: ImportProject) => {
    setSelected((current) => {
      const next = new Set(current)
      const key = rowKey(project)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const allSelected =
    projects !== null &&
    projects.length > 0 &&
    projects.every((project) => selected.has(rowKey(project)))

  const toggleAll = React.useCallback(() => {
    setSelected((current) => {
      if (!projects) return current
      if (projects.every((project) => current.has(rowKey(project)))) {
        return new Set()
      }
      return new Set(projects.map(rowKey))
    })
  }, [projects])

  const chosen = React.useMemo(
    () => (projects ?? []).filter((project) => selected.has(rowKey(project))),
    [projects, selected]
  )
  const conversations = chosen.reduce(
    (total, project) => total + project.conversations,
    0
  )

  const runImport = React.useCallback(async () => {
    if (chosen.length === 0) return
    setImporting(true)
    let imported = 0
    let skipped = 0
    try {
      // One request per CLI: each carries its own list of folders, and a
      // failure in one leaves the other's chats already written.
      for (const provider of ["claude-code", "codex"] as const) {
        const cwds = chosen
          .filter((project) => project.provider === provider)
          .map((project) => project.cwd)
        if (cwds.length === 0) continue
        const result = await api.runImport({ provider, cwds })
        imported += result.imported
        skipped += result.skipped
      }
      toast.success(
        imported === 0
          ? "Nothing new to import."
          : `Imported ${imported} conversation${imported === 1 ? "" : "s"}${
              skipped > 0 ? ` · ${skipped} already here` : ""
            }.`
      )
      onImported?.({ imported, skipped })
      close()
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : "The import didn't finish."
      )
    } finally {
      setImporting(false)
    }
  }, [chosen, close, onImported])

  if (!open) return null

  return (
    <div
      data-slot="import-dialog"
      className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[10vh]"
    >
      <div
        aria-hidden
        onClick={importing ? undefined : close}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px] duration-150 animate-in fade-in-0 motion-reduce:animate-none"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import history"
        className={cn(
          "relative flex w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border bg-popover shadow-lg",
          "duration-150 animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none"
        )}
      >
        <header className="flex items-start gap-3 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-medium">Import history</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Conversations Claude Code and Codex have already had on this
              machine, grouped by the folder they ran in.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={scanning || importing}
            onClick={() => setScanToken((token) => token + 1)}
          >
            <RefreshCw className={cn(scanning && "animate-spin")} />
            Rescan
          </Button>
        </header>

        <div className="max-h-[min(26rem,55vh)] min-h-24 overflow-y-auto p-2">
          {scanning && projects === null ? (
            <ul className="space-y-1 p-1">
              {[0, 1, 2].map((row) => (
                <li key={row} className="flex items-center gap-3 px-2 py-2">
                  <Skeleton className="size-4 rounded-sm" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-16" />
                </li>
              ))}
            </ul>
          ) : projects && projects.length > 0 ? (
            <ul className="space-y-0.5">
              {projects.map((project) => {
                const key = rowKey(project)
                const checked = selected.has(key)
                return (
                  <li key={key}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      disabled={importing}
                      onClick={() => toggle(project)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
                        "hover:bg-accent hover:text-accent-foreground",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                        "disabled:pointer-events-none disabled:opacity-60"
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input"
                        )}
                      >
                        {checked ? <Check className="size-3" /> : null}
                      </span>
                      <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">
                          {basename(project.cwd)}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {project.cwd}
                        </span>
                      </span>
                      <span className="shrink-0 text-right text-[11px] text-muted-foreground">
                        <span className="block">
                          {project.conversations} chat
                          {project.conversations === 1 ? "" : "s"} ·{" "}
                          {relativeTime(project.lastActiveAt, scannedAt)}
                        </span>
                        <span className="block">
                          {PROVIDER_LABEL[project.provider]}
                          {project.resumable ? "" : " · history only"}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">
              No Claude Code or Codex history found on this machine.
            </p>
          )}
          {truncated ? (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              Only the most recent history was scanned — there is more of it
              than one scan reads.
            </p>
          ) : null}
        </div>

        <footer className="flex items-center gap-2 border-t px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={importing || !projects || projects.length === 0}
            onClick={toggleAll}
          >
            {allSelected ? "Clear" : "Select all"}
          </Button>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {chosen.length === 0
              ? "Nothing selected"
              : `${conversations} conversation${
                  conversations === 1 ? "" : "s"
                } from ${chosen.length} folder${chosen.length === 1 ? "" : "s"}`}
          </span>
          <Button variant="ghost" size="sm" disabled={importing} onClick={close}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={importing || chosen.length === 0}
            onClick={() => void runImport()}
          >
            {importing ? <Loader2 className="animate-spin" /> : <Download />}
            {importing ? "Importing…" : "Import"}
          </Button>
        </footer>
      </div>
    </div>
  )
}

/** Last segment of a path, whichever separator it was written with. */
function basename(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
