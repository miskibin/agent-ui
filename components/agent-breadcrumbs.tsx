"use client"

import { ChevronDown, GitBranch, MessageSquare } from "lucide-react"
import type { SessionMeta } from "@/lib/store/types"
import type { SubagentCardData } from "@/lib/subagents/cards"
import { folderName } from "@/lib/folder"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

export function AgentBreadcrumbs({ session, sessions, cards, selected, onNavigate, onOpenAgent, onReturn }: {
  session?: SessionMeta
  sessions: SessionMeta[]
  cards: SubagentCardData[]
  selected?: SubagentCardData
  onNavigate: (id: string) => void
  onOpenAgent: (id: string) => void
  onReturn: () => void
}) {
  if (!session) return null
  const chain: SessionMeta[] = []
  const seen = new Set<string>()
  let current: SessionMeta | undefined = session
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    chain.unshift(current)
    current = sessions.find((item) => item.id === current?.parentId)
  }
  const siblings = sessions.filter((item) => item.parentId === (session.parentId || session.id))
  const button = "max-w-48 truncate rounded px-1 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  return (
    <nav aria-label="Agent navigation" data-slot="agent-breadcrumbs" data-tauri-drag-region className="relative z-10 flex min-w-0 flex-1 self-stretch items-center gap-1 text-[12px] text-muted-foreground">
      <MessageSquare className="size-3.5 shrink-0" />
      {session.cwd ? <><button type="button" className={`${button} hidden shrink-0 sm:block`} onClick={() => onNavigate(chain[0].id)}>{folderName(session.cwd)}</button><span aria-hidden className="hidden sm:block">/</span></> : null}
      {chain.map((item, index) => <span key={item.id} className="flex min-w-0 items-center gap-1">
        {index > 0 ? <span aria-hidden>/</span> : null}
        <button type="button" className={`${button} ${item.id === session.id && !selected ? "font-semibold text-foreground" : ""}`} aria-current={item.id === session.id && !selected ? "page" : undefined} title={item.title} onClick={() => item.id === session.id ? onReturn() : onNavigate(item.id)}>{item.title || "New chat"}</button>
      </span>)}
      {selected ? <><span aria-hidden>/</span><span aria-current="page" className="truncate font-semibold text-foreground" title={selected.title}>{selected.title}</span></> : null}
      {cards.length || siblings.length ? <DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label="Switch agent" className="shrink-0 rounded p-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"><ChevronDown className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="start" className="max-h-80 max-w-80 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onNavigate(chain[0].id)}><MessageSquare className="size-3.5" />Main agent · {chain[0].title}</DropdownMenuItem>
        {siblings.map((item) => <DropdownMenuItem key={item.id} onSelect={() => onNavigate(item.id)}><GitBranch className="size-3.5" />{item.title}</DropdownMenuItem>)}
        {cards.filter((card) => !card.sessionId || !siblings.some((item) => item.id === card.sessionId)).map((card) => <DropdownMenuItem key={card.id} onSelect={() => onOpenAgent(card.id)}><GitBranch className="size-3.5" />{card.title}</DropdownMenuItem>)}
      </DropdownMenuContent></DropdownMenu> : null}
    </nav>
  )
}
