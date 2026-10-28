"use client"

import { ArrowUpRight, Check, ChevronRight, GitBranch, LoaderCircle, Square, TriangleAlert } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import * as api from "@/lib/api-client"
import { errorMessage } from "@/lib/chat-helpers"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"
import { nativeAgents } from "@/lib/subagents/native"
import type { SubagentRunSummary } from "@/lib/subagents/types"

export const AgentsPanel = React.memo(function AgentsPanel({ sessionId, sessions, messages, agentRuns, onSelect, onOpenNative, embedded = false }: {
  sessionId: string
  sessions: SessionMeta[]
  messages: StoredMessage[]
  agentRuns: Record<string, SubagentRunSummary>
  onSelect: (id: string) => void
  onOpenNative?: (toolId: string) => void
  embedded?: boolean
}) {
  const children = React.useMemo(() => sessions.filter((session) => session.parentId === sessionId), [sessions, sessionId])
  const native = React.useMemo(() => nativeAgents(messages), [messages])
  const count = children.length + native.length
  if (!count) return null
  const active = children.filter((session) => ["running", "queued"].includes(agentRuns[session.id]?.status)).length + native.filter((agent) => agent.status === "running").length
  return (
    <details key={sessionId} data-slot="agents-panel" className={embedded ? "group/agents w-full text-[12px]" : "group/agents mx-auto mb-2 w-full max-w-3xl overflow-hidden rounded-xl border border-border bg-background/95 text-[12px] shadow-sm"}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open/agents:rotate-90" />
        <GitBranch className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{active ? `${active} running ${active === 1 ? "task" : "tasks"}` : "Agent activity"}</span>
        {!active ? <span className="rounded bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{count}</span> : null}
        <span className="ml-auto text-muted-foreground">{active ? <LoaderCircle className="size-3 motion-safe:animate-spin" /> : null}</span>
      </summary>
      <div className="max-h-[40vh] overflow-y-auto border-t border-border">
        {children.map((session) => {
          const run = agentRuns[session.id]
          const working = run?.status === "running" || run?.status === "queued"
          return (
            <div key={session.id} className="flex items-center gap-2 border-b border-border/60 px-3 py-2 last:border-0">
              <AgentStatus status={run?.status} />
              <button type="button" onClick={() => onSelect(session.id)} className="min-w-0 flex-1 rounded text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring">
                <span className="block truncate font-medium">{session.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{session.providerId} · {session.model || "Default model"} · {run?.status ?? "Saved chat"}</span>
              </button>
              {working && run ? <button type="button" aria-label={`Stop ${session.title}`} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void api.cancelSubagent(run.runId).catch((error) => toast.error(errorMessage(error, "Could not stop agent")))}><Square className="size-3" /></button> : null}
              <button type="button" aria-label={`Open ${session.title}`} onClick={() => onSelect(session.id)} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><ArrowUpRight className="size-3.5" /></button>
            </div>
          )
        })}
        {native.map((agent) => onOpenNative ? (
          <button type="button" key={agent.id} onClick={() => onOpenNative(agent.parentToolId)} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"><AgentStatus status={agent.status} /><span className="min-w-0 flex-1 truncate">{agent.title}</span><ArrowUpRight className="size-3 shrink-0" /></button>
        ) : (
          <details key={agent.id} className="group/agent border-b border-border/60 last:border-0">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <AgentStatus status={agent.status} />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{agent.title}</span><span className="block truncate text-[11px] text-muted-foreground">Claude Code · {agent.model || "Model not reported"} · {agent.status === "error" ? "Failed or interrupted" : agent.status} · Native</span></span>
              <ChevronRight className="size-3.5 text-muted-foreground group-open/agent:rotate-90" />
            </summary>
            <div className="space-y-3 border-t border-border/60 bg-muted/20 px-4 py-3">
              {agent.prompt ? <p className="whitespace-pre-wrap text-muted-foreground">{agent.prompt}</p> : null}
              {agent.tools.map((tool) => <details key={tool.id}><summary className="cursor-pointer truncate text-[11px] text-muted-foreground">{tool.name} · {tool.status}</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words py-2 text-[11px]">{tool.input}{tool.output ? `\n${tool.output}` : ""}</pre></details>)}
              <p className="whitespace-pre-wrap break-words leading-relaxed">{agent.text || "No text reported by the harness."}</p>
              <p className="text-[11px] text-muted-foreground">Managed by Claude Code. Stop the parent turn to interrupt its agents.</p>
            </div>
          </details>
        ))}
      </div>
    </details>
  )
})

function AgentStatus({ status }: { status?: string }) {
  if (status === "running" || status === "queued") return <LoaderCircle aria-label={status} className="size-3.5 shrink-0 text-primary motion-safe:animate-spin" />
  if (status === "error" || status === "cancelled") return <TriangleAlert aria-label={status} className="size-3.5 shrink-0 text-destructive" />
  if (status === "done") return <Check aria-label="Completed" className="size-3.5 shrink-0 text-muted-foreground" />
  return <GitBranch aria-label="Saved agent" className="size-3.5 shrink-0 text-muted-foreground" />
}
