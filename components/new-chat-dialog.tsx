"use client"

import { FolderOpen, MessageSquare, X } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"
import { FolderLogoMark } from "@/components/folder-logo"
import type { FolderSelection } from "@/components/folder-picker"
import { Input } from "@/components/ui/input"
import * as api from "@/lib/api-client"
import { hasNativeFolderPicker, pickFolderNative } from "@/lib/desktop"
import { folderName } from "@/lib/folder"
import { normalizeFolderForComparison } from "@/lib/folder-identity"
import type { SessionMeta } from "@/lib/store/types"

/** Known projects paint immediately; neither a directory walk nor git blocks opening. */
export function NewChatDialog({ open, onOpenChange, sessions, recents, onSelect }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: SessionMeta[]
  recents: string[]
  onSelect: (selection: FolderSelection) => Promise<boolean>
}) {
  const dialog = React.useRef<HTMLDialogElement>(null)
  const opener = React.useRef<HTMLElement | null>(null)
  const busy = React.useRef(false)
  const [query, setQuery] = React.useState("")
  const [pending, setPending] = React.useState(false)
  React.useEffect(() => {
    if (open) {
      opener.current = document.activeElement as HTMLElement
      dialog.current?.showModal()
    } else {
      dialog.current?.close()
      opener.current?.focus()
    }
    return () => { if (open) opener.current?.focus() }
  }, [open])
  const folders = React.useMemo(() => {
    const seen = new Set<string>()
    return [...sessions.map((session) => session.cwd ?? ""), ...recents].filter((path) => {
      const key = normalizeFolderForComparison(path)
      if (!path || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [sessions, recents])
  const select = async (cwd: string) => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    try {
      let gitBranch = sessions.find((session) => session.cwd === cwd)?.gitBranch ?? ""
      if (cwd) {
        const info = await api.fetchFolderInfo(cwd, false)
        if (!info.exists || !info.isDir) { toast.error("That folder is no longer available."); return }
        cwd = info.path
        gitBranch = info.currentBranch || gitBranch
      }
      if (await onSelect({ cwd, gitBranch })) {
        onOpenChange(false)
        setQuery("")
        if (cwd) void api.rememberFolder(cwd).catch(() => {})
      }
    } catch { toast.error("Could not open that folder.") }
    finally { busy.current = false; setPending(false) }
  }
  const row = "flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-3 text-left text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
  const matches = folders.filter((path) => path.toLowerCase().includes(query.toLowerCase())).slice(0, 20)
  return (
    <dialog ref={dialog} aria-labelledby="new-chat-title" data-slot="new-chat-dialog" onCancel={() => onOpenChange(false)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onOpenChange(false) } }} onClick={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onOpenChange(false) } }} className="fixed inset-0 m-auto max-h-[min(36rem,85dvh)] w-[min(29rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-border bg-popover p-0 text-popover-foreground shadow-xl backdrop:bg-black/35">
      <div className="flex items-center justify-between px-5 pt-4 pb-3"><h2 id="new-chat-title" className="text-[15px] font-semibold">New chat</h2><button type="button" aria-label="Close new chat" onClick={() => onOpenChange(false)} className="rounded p-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" /></button></div>
      <form className="px-4 pb-3" onSubmit={(event) => { event.preventDefault(); if (query.trim()) void select(query.trim()) }}><Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search folders or enter a path" placeholder="Search folders or enter a path…" className="h-10 text-[13px]" /></form>
      <div aria-busy={pending} className="max-h-[55dvh] overflow-y-auto px-2 pb-2">
        <button type="button" disabled={pending} className={row} onClick={() => void select("")}><MessageSquare className="size-4 shrink-0 text-muted-foreground" /><span>No folder</span></button>
        {matches.length ? <p className="px-3 pt-3 pb-1 text-[11px] text-muted-foreground">Recent folders</p> : null}
        {matches.map((cwd) => <button type="button" key={cwd} disabled={pending} className={row} onClick={() => void select(cwd)}><FolderLogoMark cwd={cwd} className="size-5" /><span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate font-medium">{folderName(cwd)}</span><span className="truncate text-[11px] text-muted-foreground">{cwd}</span></span></button>)}
        {query.trim() && !matches.includes(query.trim()) ? <button type="button" disabled={pending} className={row} onClick={() => void select(query.trim())}><FolderOpen className="size-4" /><span className="truncate">Use {query.trim()}</span></button> : null}
        {hasNativeFolderPicker() ? <button type="button" disabled={pending} className={row} onClick={() => { void pickFolderNative().then((path) => { if (path) void select(path) }).catch(() => toast.error("The system folder chooser didn't open.")) }}><FolderOpen className="size-4" />Browse folders…</button> : null}
      </div>
    </dialog>
  )
}
