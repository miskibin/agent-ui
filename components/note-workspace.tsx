"use client"

import {
  ArrowUp,
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
import { createPortal } from "react-dom"
import { toast } from "sonner"

import { useNoteDoc } from "@/app/hooks/use-note-doc"
import { AppHeaderButton } from "@/components/app-header"
import { ComposerModelPicker } from "@/components/composer-model-picker"
import { ProviderPicker } from "@/components/provider-picker"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { GenerationStatus } from "@/components/ui/generation-status"
import {
  NoteEditor,
  type NoteEditorAction,
  type NoteEditorAnchor,
  type NoteEditorHandle,
  type NoteEditorSelection,
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
  const [modelsLoading, setModelsLoading] = React.useState(false)
  const [modelsToken, setModelsToken] = React.useState(0)
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
    queueMicrotask(() => {
      if (live) setModelsLoading(true)
    })
    api
      .fetchModels(providerId, modelsToken > 0)
      .then((answer) => {
        if (live) setModels(answer.models.filter((model) => !model.disabled))
      })
      .catch(() => {
        if (live) setModels([])
      })
      .finally(() => {
        if (live) setModelsLoading(false)
      })
    return () => {
      live = false
    }
  }, [providerId, modelsToken])

  const refreshModels = React.useCallback(() => setModelsToken((token) => token + 1), [])

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

  return { providers, models, modelsLoading, refreshModels, providerId, model, pick, resolve }
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
        <AppHeaderButton label="Note history">
          <History />
        </AppHeaderButton>
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

const ICON_BUTTON =
  "inline-grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"

/**
 * One thread in the margin: the words it hangs on, the exchange, and the
 * actions on hover. No card — the margin is a column of text, and the active
 * thread is the one with a tint behind it.
 */
function ThreadItem({
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
      tabIndex={0}
      onClick={() => onSelect(thread.id)}
      // The thread is the way back to its words; Enter or Space on it (not on
      // a control inside) selects it like a click.
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect(thread.id)
        }
      }}
      className={cn(
        "group/thread rounded-lg px-2.5 py-2 text-[12.5px] leading-snug outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active ? "bg-accent" : "hover:bg-accent/50",
        thread.resolved && "opacity-60"
      )}
    >
      {thread.anchor ? (
        <p className="mb-1.5 line-clamp-2 text-[11.5px] text-muted-foreground">
          <span className="mr-1.5 inline-block h-2.5 w-0.5 rounded-full bg-primary/50 align-middle" />
          {thread.anchor}
        </p>
      ) : null}
      <ol className="space-y-1">
        {thread.messages.map((message) => (
          <li
            key={message.id}
            data-slot="note-thread-message"
            data-author={message.author}
            className={cn(
              message.author === "user" ? "text-foreground" : "text-muted-foreground",
              message.error && "text-destructive"
            )}
          >
            {message.author === "agent" ? (
              <Sparkles aria-label="Agent" className="mr-1 inline size-3 -translate-y-px" />
            ) : null}
            {message.text}
          </li>
        ))}
      </ol>
      <div className="mt-1 flex h-6 items-center gap-0.5">
        {busy ? (
          <>
            <GenerationStatus
              active
              label={thread.status === "queued" ? "Waiting" : "Working"}
              startedAt={thread.status === "running" ? thread.updatedAt : undefined}
              className="text-[11.5px]"
            />
            <button
              type="button"
              aria-label="Stop"
              title="Stop"
              onClick={(event) => {
                event.stopPropagation()
                onStop(thread)
              }}
              className={cn(ICON_BUTTON, "ml-auto")}
            >
              <Square className="size-2.5 fill-current" />
            </button>
          </>
        ) : (
          <>
            <span className="flex-1 text-[11px] text-muted-foreground/70">{relativeTime(thread.updatedAt)}</span>
            <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/thread:opacity-100 group-focus-within/thread:opacity-100 group-data-[active=true]/thread:opacity-100">
              <button
                type="button"
                aria-label={thread.resolved ? "Reopen" : "Resolve"}
                title={thread.resolved ? "Reopen" : "Resolve"}
                onClick={(event) => {
                  event.stopPropagation()
                  onResolve(thread, !thread.resolved)
                }}
                className={ICON_BUTTON}
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
                className={ICON_BUTTON}
              >
                <Trash2 className="size-3.5" />
              </button>
            </span>
          </>
        )}
      </div>
      {active && !busy && !thread.resolved ? (
        <form
          className="mt-1"
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
            placeholder="Reply…"
            className="h-7 w-full rounded-md bg-background/60 px-2 text-[12px] outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </form>
      ) : null}
    </div>
  )
}

/**
 * The note's composer: one line, docked at the bottom like the chat's. The
 * words selected in the note follow into it as a quote — select, type, Enter
 * — and the harness and model sit at its end, which is the only place they
 * are picked.
 */
function NoteComposer({
  agent,
  selection,
  onClearSelection,
  onSend,
  inputRef,
}: {
  agent: ReturnType<typeof useNoteAgent>
  selection: NoteEditorSelection | null
  onClearSelection: () => void
  onSend: (instruction: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const [text, setText] = React.useState("")
  const providerName = agent.providers.find((provider) => provider.id === agent.providerId)?.name ?? "the agent"
  const send = () => {
    const instruction = text.trim()
    if (!instruction) return
    onSend(instruction)
    setText("")
  }

  return (
    <form
      data-slot="note-composer"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
      className="pointer-events-auto mx-auto flex w-full max-w-3xl flex-col rounded-2xl border bg-background px-2 py-1.5 shadow-sm"
    >
      {selection ? (
        <div data-slot="note-composer-selection" className="flex min-w-0 items-center gap-1.5 px-1.5 pt-0.5 text-[11.5px] text-muted-foreground">
          <span className="h-3 w-0.5 shrink-0 rounded-full bg-primary/60" />
          <span className="min-w-0 truncate">{selection.text.replace(/\s+/g, " ")}</span>
          <button type="button" aria-label="Leave the selection out" onClick={onClearSelection} className={cn(ICON_BUTTON, "size-5")}>
            <X className="size-3" />
          </button>
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-1">
        <input
          ref={inputRef}
          data-slot="note-composer-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && selection) {
              event.preventDefault()
              onClearSelection()
            }
          }}
          placeholder={
            agent.providers.length === 0
              ? "No agent can work in notes — enable Claude Code or pi in Settings"
              : selection
                ? "Ask about the selection…"
                : `Ask ${providerName} to change this note…`
          }
          disabled={agent.providers.length === 0}
          className="h-8 min-w-0 flex-1 bg-transparent px-1.5 text-[13px] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        {agent.providers.length > 0 ? (
          <>
            <ProviderPicker
              providers={agent.providers}
              value={agent.providerId}
              onChange={(providerId) => agent.pick({ providerId })}
              className="shrink-0 max-sm:[&_[data-composer-label]]:hidden"
            />
            <ComposerModelPicker
              options={agent.models}
              value={agent.model}
              onChange={(model) => agent.pick({ providerId: agent.providerId, model })}
              loading={agent.modelsLoading}
              onRefresh={agent.refreshModels}
              className="h-7 max-w-44 shrink sm:h-7"
            />
          </>
        ) : null}
        <button
          type="submit"
          aria-label="Send"
          disabled={!text.trim() || agent.providers.length === 0}
          className="inline-grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
        >
          <ArrowUp className="size-3.5" />
        </button>
      </div>
    </form>
  )
}

/**
 * A note, open in the main pane: the vendored `NoteEditor`, the threads
 * hung on its words in a quiet margin — Claude Docs' comments, where the
 * agent answers — and a one-line composer the selection flows into. Its
 * edits land in the note live, as revisions; its reply lands in the thread.
 *
 * The note's own controls (save state, history, threads, close) are
 * rendered into the app header through `headerSlot`, so the window keeps
 * the one header it has everywhere else.
 *
 * App-local: it is the host's furniture around the vendored editor — the
 * vault, the harness picker, the thread margin and the revision list.
 */
export function NoteWorkspace({
  noteId,
  onClose,
  onMetaChange,
  headerSlot,
  className,
}: {
  noteId: string
  onClose?: () => void
  /** The title or time moved — the sidebar row should follow. */
  onMetaChange?: (meta: NoteMeta) => void
  /** Where the note's header controls go; inline above the note without one. */
  headerSlot?: HTMLElement | null
  className?: string
}) {
  const doc = useNoteDoc(noteId, onMetaChange)
  const agent = useNoteAgent(doc.meta)
  const editorRef = React.useRef<NoteEditorHandle>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [activeThreadId, setActiveThreadId] = React.useState<string>()
  const [showResolved, setShowResolved] = React.useState(false)
  const [threadsOpen, setThreadsOpen] = React.useState(true)
  const [selection, setSelection] = React.useState<NoteEditorSelection | null>(null)

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

  const clearSelection = React.useCallback(() => {
    editorRef.current?.clearSelection()
    setSelection(null)
  }, [])

  const send = (instruction: string) => {
    void ask({ anchor: selection?.text, instruction })
    clearSelection()
  }

  const actions = React.useMemo<NoteEditorAction[]>(
    () => [
      {
        id: "ask",
        label: "Ask the agent",
        icon: <Sparkles />,
        needsSelection: true,
        movesFocus: true,
        onSelect: () => inputRef.current?.focus(),
      },
    ],
    []
  )

  const open = doc.threads.filter((thread) => !thread.resolved)
  const resolved = doc.threads.filter((thread) => thread.resolved)
  const showThreads = threadsOpen && doc.threads.length > 0

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

  const controls = (
    <div data-slot="note-header-controls" className="flex items-center gap-1">
      <span
        data-slot="note-save-state"
        data-state={doc.saveState}
        className={cn(
          "hidden px-1 text-[11px] text-muted-foreground sm:inline",
          doc.saveState === "error" && "text-destructive"
        )}
      >
        {doc.saveState === "saving" ? "Saving…" : doc.saveState === "error" ? "Not saved — retrying" : "Saved"}
      </span>
      <HistoryMenu noteId={noteId} rev={doc.meta?.rev} />
      {doc.threads.length ? (
        <AppHeaderButton
          label={threadsOpen ? "Hide threads" : "Show threads"}
          aria-pressed={threadsOpen}
          onClick={() => setThreadsOpen((value) => !value)}
        >
          <MessageSquareText />
          {open.length ? <span className="tabular-nums">{open.length}</span> : null}
        </AppHeaderButton>
      ) : null}
      {onClose ? (
        <AppHeaderButton label="Close note" onClick={onClose}>
          <X />
        </AppHeaderButton>
      ) : null}
    </div>
  )

  return (
    <section
      data-slot="note-workspace"
      aria-label={doc.meta?.title ?? "Note"}
      className={cn("relative flex h-full min-h-0 flex-col bg-background", className)}
    >
      {headerSlot ? createPortal(controls, headerSlot) : <div className="flex justify-end px-3 py-1">{controls}</div>}

      <div className="flex min-h-0 flex-1">
        <div data-slot="note-workspace-editor" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {doc.error ? (
            <p className="p-6 text-[13px] text-destructive">{doc.error}</p>
          ) : doc.value === null ? (
            <div className="flex items-center gap-2 p-6 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Opening note…
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl pb-24">
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
                onSelectionChange={setSelection}
                actions={actions}
                uploadImage={uploadNoteImage}
                resolveImageUrl={noteImageUrl}
                placeholder="Start writing — or select text and ask the agent below."
              />
            </div>
          )}
        </div>

        {showThreads ? (
          <aside
            data-slot="note-threads"
            aria-label="Threads"
            className="flex w-72 shrink-0 flex-col pb-24 max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-10 max-md:bg-background max-md:shadow-lg"
          >
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pt-3">
              {open.map((thread) => (
                <ThreadItem key={thread.id} thread={thread} active={thread.id === activeThreadId} {...handlers} />
              ))}
              {resolved.length ? (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => setShowResolved((value) => !value)}
                    className="w-full rounded-md px-2.5 py-1 text-left text-[11.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {showResolved ? "Hide" : "Show"} resolved ({resolved.length})
                  </button>
                  {showResolved ? (
                    <div className="mt-1 space-y-1">
                      {resolved.map((thread) => (
                        <ThreadItem key={thread.id} thread={thread} active={thread.id === activeThreadId} {...handlers} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-background via-background/90 to-transparent px-3 pt-6 pb-3">
        <NoteComposer
          agent={agent}
          selection={selection}
          onClearSelection={clearSelection}
          onSend={send}
          inputRef={inputRef}
        />
      </div>
    </section>
  )
}
