"use client"

import {
  Check,
  History,
  Loader2,
  MessageSquareText,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
} from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { useNoteDoc } from "@/app/hooks/use-note-doc"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { GenerationStatus } from "@/components/ui/generation-status"
import {
  NoteEditor,
  type NoteEditorAnchor,
  type NoteEditorAsk,
  type NoteEditorHandle,
} from "@/components/ui/note-editor"
import type { ModelOption } from "@/components/ui/model-picker"
import * as api from "@/lib/api-client"
import {
  askNote,
  cancelNoteAsk,
  deleteThread,
  fetchNoteHistory,
  noteImageUrl,
  resolveThread,
  restoreNote,
  uploadNoteImage,
} from "@/lib/notes/client"
import {
  canWorkInNotes,
  type NoteHistoryEntry,
  type NoteMeta,
  type NoteThread,
} from "@/lib/notes/types"
import type { ProviderInfo } from "@/lib/providers/types"
import { cn } from "@/lib/utils"

const AGENT_KEY = "agent-ui:note-agent"

function readAgentChoice(): { providerId?: string; model?: string } {
  try {
    return JSON.parse(localStorage.getItem(AGENT_KEY) ?? "{}") as { providerId?: string; model?: string }
  } catch {
    return {}
  }
}

function saveAgentChoice(choice: { providerId: string; model: string }) {
  try {
    localStorage.setItem(AGENT_KEY, JSON.stringify(choice))
  } catch {
    /* a convenience only */
  }
}

function relativeTime(at: number) {
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(at).toLocaleDateString()
}

type AgentChoice = { providerId: string; model: string }

function pickProviderId(providers: ProviderInfo[], choice: AgentChoice, meta: NoteMeta | null) {
  if (choice.providerId && providers.some((p) => p.id === choice.providerId)) return choice.providerId
  const saved = readAgentChoice()
  const preferred = [meta?.providerId, saved.providerId, "claudeCode", "pi"]
  return preferred.find((id) => id && providers.some((p) => p.id === id)) ?? providers[0]?.id ?? ""
}

function pickModel(models: ModelOption[], providerId: string, choice: AgentChoice, meta: NoteMeta | null) {
  const ids = models.map((option) => option.id)
  const saved = readAgentChoice()
  const preferred = [
    choice.providerId === providerId ? choice.model : "",
    meta?.providerId === providerId ? meta?.model : "",
    saved.providerId === providerId ? saved.model : "",
  ]
  return preferred.find((id) => id && ids.includes(id)) ?? ids[0] ?? ""
}

/**
 * The harness and model a note's asks run on. Only harnesses that can reach
 * the note tools are offered (`canWorkInNotes`); the choice is remembered
 * across notes, and a note's own last choice wins when it has one.
 * `resolve()` waits for the lists, so an ask made the instant a note opens
 * still goes to the right agent.
 */
function useNoteAgent(meta: NoteMeta | null) {
  const [providers, setProviders] = React.useState<ProviderInfo[]>([])
  const [models, setModels] = React.useState<ModelOption[]>([])
  const [choice, setChoice] = React.useState<AgentChoice>({ providerId: "", model: "" })
  const providersRef = React.useRef<Promise<ProviderInfo[]> | null>(null)

  React.useEffect(() => {
    let live = true
    const loading = api
      .fetchProviders()
      .then((list) => list.filter(canWorkInNotes))
      .catch(() => [] as ProviderInfo[])
    providersRef.current = loading
    void loading.then((list) => {
      if (live) setProviders(list)
    })
    return () => {
      live = false
    }
  }, [])

  const providerId = React.useMemo(() => pickProviderId(providers, choice, meta), [providers, choice, meta])

  React.useEffect(() => {
    if (!providerId) return
    let live = true
    api
      .fetchModels(providerId)
      .then((answer) => {
        if (live) setModels(answer.models.filter((model) => !model.disabled))
      })
      .catch(() => {
        if (live) setModels([])
      })
    return () => {
      live = false
    }
  }, [providerId])

  const model = React.useMemo(() => pickModel(models, providerId, choice, meta), [models, providerId, choice, meta])

  const pick = React.useCallback((next: { providerId: string; model?: string }) => {
    const value = { providerId: next.providerId, model: next.model ?? "" }
    setChoice(value)
    if (value.model) saveAgentChoice(value)
  }, [])

  const latest = React.useRef({ choice, meta, providerId, model })
  React.useEffect(() => {
    latest.current = { choice, meta, providerId, model }
  }, [choice, meta, providerId, model])

  const resolve = React.useCallback(async (): Promise<AgentChoice | null> => {
    const list = (await providersRef.current) ?? []
    const now = latest.current
    const id = pickProviderId(list, now.choice, now.meta)
    if (!id) return null
    if (id === now.providerId && now.model) return { providerId: id, model: now.model }
    const answer = await api.fetchModels(id).catch(() => ({ models: [] as ModelOption[] }))
    return { providerId: id, model: pickModel(answer.models.filter((m) => !m.disabled), id, now.choice, now.meta) }
  }, [])

  return { providers, models, providerId, model, pick, resolve }
}

function threadAnchorState(thread: NoteThread): NoteEditorAnchor["state"] {
  if (thread.status === "running" || thread.status === "queued") return "running"
  if (thread.status === "error") return "error"
  if (thread.status === "done") return "done"
  return "open"
}

function HistoryMenu({ noteId, rev }: { noteId: string; rev?: number }) {
  const [open, setOpen] = React.useState(false)
  const [entries, setEntries] = React.useState<NoteHistoryEntry[] | null>(null)
  React.useEffect(() => {
    if (!open) return
    let live = true
    fetchNoteHistory(noteId)
      .then((list) => {
        if (live) setEntries(list)
      })
      .catch(() => {
        if (live) setEntries([])
      })
    return () => {
      live = false
    }
  }, [open, noteId, rev])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Note history"
          title="History"
          className="inline-grid size-8 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4"
        >
          <History />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1">
        <p className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">Revisions</p>
        {entries === null ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">No revisions yet.</p>
        ) : (
          <ul data-slot="note-history" className="max-h-72 overflow-y-auto">
            {entries.map((entry, index) => (
              <li key={entry.rev} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-accent">
                {entry.author === "agent" ? (
                  <Sparkles className="size-3 shrink-0 text-muted-foreground" aria-label="Agent" />
                ) : (
                  <span className="size-3 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {entry.author === "agent" ? "Agent edit" : entry.author === "external" ? "Changed on disk" : "Your edits"}
                  <span className="text-muted-foreground"> · {relativeTime(entry.at)}</span>
                </span>
                {index === 0 ? (
                  <span className="text-[11px] text-muted-foreground">current</span>
                ) : (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    onClick={() => {
                      restoreNote(noteId, entry.rev)
                        .then(() => {
                          setOpen(false)
                          toast.success("Restored — the restore is a revision too.")
                        })
                        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Could not restore"))
                    }}
                  >
                    <RotateCcw className="size-3" /> Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

function ThreadCard({
  thread,
  active,
  onSelect,
  onReply,
  onStop,
  onResolve,
  onDelete,
}: {
  thread: NoteThread
  active: boolean
  onSelect: (id: string) => void
  onReply: (thread: NoteThread, text: string) => void
  onStop: (thread: NoteThread) => void
  onResolve: (thread: NoteThread, resolved: boolean) => void
  onDelete: (thread: NoteThread) => void
}) {
  const [reply, setReply] = React.useState("")
  const busy = thread.status === "running" || thread.status === "queued"
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [active])

  return (
    <div
      ref={ref}
      data-slot="note-thread"
      data-state={thread.status}
      data-active={active ? "true" : undefined}
      data-resolved={thread.resolved ? "true" : undefined}
      className={cn(
        "group/thread rounded-lg border bg-card p-2.5 text-[12.5px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active ? "border-primary/50 ring-1 ring-primary/20" : "hover:border-foreground/20",
        thread.resolved && "opacity-70"
      )}
      tabIndex={0}
      onClick={() => onSelect(thread.id)}
      // The card is the way back to its words; Enter or Space on it (not on
      // a control inside) selects it like a click.
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect(thread.id)
        }
      }}
    >
      {thread.anchor ? (
        <p className="mb-2 line-clamp-2 border-l-2 border-primary/40 pl-2 text-[11.5px] leading-snug text-muted-foreground">
          {thread.anchor}
        </p>
      ) : null}
      <ol className="space-y-1.5">
        {thread.messages.map((message) => (
          <li
            key={message.id}
            data-slot="note-thread-message"
            data-author={message.author}
            className={cn("leading-snug", message.error && "text-destructive")}
          >
            {message.author === "agent" ? (
              <Sparkles aria-label="Agent" className="mr-1 inline size-3 -translate-y-px text-muted-foreground" />
            ) : null}
            <span className={message.author === "user" ? "font-medium" : undefined}>{message.text}</span>
          </li>
        ))}
      </ol>
      {busy ? (
        <div className="mt-2 flex items-center gap-2">
          <GenerationStatus
            active
            label={thread.status === "queued" ? "Waiting" : "Working"}
            startedAt={thread.status === "running" ? thread.updatedAt : undefined}
            className="text-[11.5px]"
          />
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onStop(thread)
            }}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Square className="size-2.5 fill-current" /> Stop
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1">
          {active && !thread.resolved ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault()
                if (!reply.trim()) return
                onReply(thread, reply.trim())
                setReply("")
              }}
            >
              <input
                data-slot="note-thread-reply"
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                placeholder="Follow up…"
                className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-[12px] outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </form>
          ) : (
            <span className="flex-1 text-[11px] text-muted-foreground">{relativeTime(thread.updatedAt)}</span>
          )}
          <button
            type="button"
            aria-label={thread.resolved ? "Reopen" : "Resolve"}
            title={thread.resolved ? "Reopen" : "Resolve"}
            onClick={(event) => {
              event.stopPropagation()
              onResolve(thread, !thread.resolved)
            }}
            className="inline-grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {thread.resolved ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
          </button>
          <button
            type="button"
            aria-label="Delete thread"
            title="Delete thread"
            onClick={(event) => {
              event.stopPropagation()
              onDelete(thread)
            }}
            className="inline-grid size-7 place-items-center rounded-md text-muted-foreground opacity-0 outline-none transition-colors group-hover/thread:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * A note, open in the main pane: the vendored `NoteEditor` on the left, and
 * the threads the person hung on its words on the right — Claude Docs'
 * margin, where the agent answers. Selecting words and pressing ⌘E asks the
 * picked harness to act on them; its edits land in the note live, as
 * revisions, and its reply lands in the thread.
 *
 * App-local: it is the host's furniture around the vendored editor — the
 * vault, the harness picker, the thread margin and the revision list.
 */
export function NoteWorkspace({
  noteId,
  onClose,
  onMetaChange,
  className,
}: {
  noteId: string
  onClose?: () => void
  /** The title or time moved — the sidebar row should follow. */
  onMetaChange?: (meta: NoteMeta) => void
  className?: string
}) {
  const doc = useNoteDoc(noteId, onMetaChange)
  const agent = useNoteAgent(doc.meta)
  const editorRef = React.useRef<NoteEditorHandle>(null)
  const [activeThreadId, setActiveThreadId] = React.useState<string>()
  const [showResolved, setShowResolved] = React.useState(false)
  const [threadsOpen, setThreadsOpen] = React.useState(true)

  const anchors = React.useMemo<NoteEditorAnchor[]>(
    () =>
      doc.threads
        .filter((thread) => !thread.resolved && thread.anchor)
        .map((thread) => ({ id: thread.id, text: thread.anchor, state: threadAnchorState(thread) })),
    [doc.threads]
  )

  const refreshThreads = doc.refreshThreads
  const resolveAgent = agent.resolve

  const ask = React.useCallback(
    async (input: { anchor?: string; threadId?: string; instruction: string }) => {
      const picked = await resolveAgent()
      if (!picked) {
        toast.error("No agent can work in notes — enable Claude Code or pi in Settings.")
        return
      }
      askNote(noteId, { ...input, ...picked })
        .then(({ threadId }) => {
          setActiveThreadId(threadId)
          setThreadsOpen(true)
          void refreshThreads()
        })
        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Could not ask the agent"))
    },
    [noteId, refreshThreads, resolveAgent]
  )

  const onAsk = React.useCallback(
    (request: NoteEditorAsk) => void ask({ anchor: request.text, instruction: request.instruction }),
    [ask]
  )

  const open = doc.threads.filter((thread) => !thread.resolved)
  const resolved = doc.threads.filter((thread) => thread.resolved)

  const handlers = {
    onSelect: setActiveThreadId,
    onReply: (thread: NoteThread, text: string) => void ask({ threadId: thread.id, instruction: text }),
    onStop: (thread: NoteThread) => {
      void cancelNoteAsk(noteId, thread.id).catch(() => undefined)
    },
    onResolve: (thread: NoteThread, next: boolean) => {
      resolveThread(noteId, thread.id, next).catch((err: unknown) =>
        toast.error(err instanceof Error ? err.message : "Could not update the thread")
      )
    },
    onDelete: (thread: NoteThread) => {
      deleteThread(noteId, thread.id).catch((err: unknown) =>
        toast.error(err instanceof Error ? err.message : "Could not delete the thread")
      )
    },
  }

  return (
    <section
      data-slot="note-workspace"
      aria-label={doc.meta?.title ?? "Note"}
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
    >
      <header
        data-slot="note-workspace-header"
        className="flex h-11 shrink-0 items-center gap-1.5 border-b px-3 text-[13px]"
      >
        <span className="min-w-0 flex-1 truncate font-medium">{doc.meta?.title ?? "Note"}</span>
        <span
          data-slot="note-save-state"
          data-state={doc.saveState}
          className={cn(
            "hidden shrink-0 text-[11px] text-muted-foreground sm:inline",
            doc.saveState === "error" && "text-destructive"
          )}
        >
          {doc.saveState === "saving" ? "Saving…" : doc.saveState === "error" ? "Not saved — retrying" : "Saved"}
        </span>
        {agent.providers.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1" data-slot="note-agent-picker">
            <Sparkles className="size-3.5 text-muted-foreground" aria-hidden />
            <Select value={agent.providerId} onValueChange={(providerId) => agent.pick({ providerId })}>
              <SelectTrigger size="sm" aria-label="Agent" className="h-7 w-auto max-w-36 gap-1 border-0 bg-transparent px-1.5 text-[12px] shadow-none hover:bg-accent">
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent>
                {agent.providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id} className="text-[12.5px]">
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agent.models.length > 0 ? (
              <Select value={agent.model} onValueChange={(model) => agent.pick({ providerId: agent.providerId, model })}>
                <SelectTrigger size="sm" aria-label="Model" className="h-7 w-auto max-w-44 gap-1 border-0 bg-transparent px-1.5 text-[12px] shadow-none hover:bg-accent">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent>
                  {agent.models.map((model) => (
                    <SelectItem key={model.id} value={model.id} className="text-[12.5px]">
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        ) : null}
        <HistoryMenu noteId={noteId} rev={doc.meta?.rev} />
        <button
          type="button"
          aria-label={threadsOpen ? "Hide threads" : "Show threads"}
          aria-pressed={threadsOpen}
          title="Threads"
          onClick={() => setThreadsOpen((value) => !value)}
          className="relative inline-grid size-8 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:text-foreground [&_svg]:size-4"
        >
          <MessageSquareText />
          {open.length ? (
            <span className="absolute -right-0.5 -top-0.5 grid min-w-3.5 place-items-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-3.5 text-primary-foreground">
              {open.length}
            </span>
          ) : null}
        </button>
        {onClose ? (
          <button
            type="button"
            aria-label="Close note"
            title="Close note"
            onClick={onClose}
            className="inline-grid size-8 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4"
          >
            <X />
          </button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        <div data-slot="note-workspace-editor" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {doc.error ? (
            <p className="p-6 text-[13px] text-destructive">{doc.error}</p>
          ) : doc.value === null ? (
            <div className="flex items-center gap-2 p-6 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Opening note…
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl pt-4">
              <NoteEditor
                ref={editorRef}
                value={doc.value}
                onChange={doc.onChange}
                anchors={anchors}
                activeAnchorId={activeThreadId}
                onAnchorClick={(id) => {
                  setActiveThreadId(id)
                  setThreadsOpen(true)
                }}
                onAsk={onAsk}
                uploadImage={uploadNoteImage}
                resolveImageUrl={noteImageUrl}
                placeholder="Start writing. Select text and press ⌘E to ask the agent."
              />
            </div>
          )}
        </div>

        {threadsOpen ? (
          <aside
            data-slot="note-threads"
            aria-label="Threads"
            className="flex w-72 shrink-0 flex-col border-l max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-10 max-md:bg-background max-md:shadow-lg"
          >
            <div className="flex h-9 shrink-0 items-center px-3 text-[11.5px] font-medium text-muted-foreground">
              Threads
              {open.length ? <span className="ml-1.5 tabular-nums">{open.length}</span> : null}
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 pb-4">
              {open.length === 0 ? (
                <div className="rounded-lg border border-dashed p-3 text-[12px] leading-relaxed text-muted-foreground">
                  Select words in the note and press{" "}
                  <kbd className="rounded border bg-muted px-1 font-mono text-[10.5px]">⌘E</kbd> (or the{" "}
                  <Sparkles className="inline size-3" aria-label="sparkles" /> button) to ask{" "}
                  {agent.providers.find((p) => p.id === agent.providerId)?.name ?? "the agent"} to rewrite them, add
                  a diagram, a table, an explanation… Its answers appear here.
                  {agent.providers.length === 0 ? (
                    <span className="mt-2 block text-destructive">
                      No agent can work in notes yet — enable Claude Code or pi in Settings.
                    </span>
                  ) : null}
                </div>
              ) : null}
              {open.map((thread) => (
                <ThreadCard key={thread.id} thread={thread} active={thread.id === activeThreadId} {...handlers} />
              ))}
              {resolved.length ? (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => setShowResolved((value) => !value)}
                    className="w-full rounded-md px-1 py-1 text-left text-[11.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {showResolved ? "Hide" : "Show"} resolved ({resolved.length})
                  </button>
                  {showResolved ? (
                    <div className="mt-1 space-y-2">
                      {resolved.map((thread) => (
                        <ThreadCard key={thread.id} thread={thread} active={thread.id === activeThreadId} {...handlers} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  )
}
