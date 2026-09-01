"use client"

import { arrayMove } from "@dnd-kit/sortable"
import {
  Copy,
  HelpCircle,
  Palette,
  PanelLeft,
  Paperclip,
  Pencil,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  Waves,
} from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import {
  AppHeader,
  AppHeaderActions,
  AppHeaderBrand,
  AppHeaderButton,
  AppHeaderTitle,
} from "@/components/app-header"
import {
  CommandPalette,
  type CommandPaletteSession,
} from "@/components/command-palette"
import { FolderPicker } from "@/components/folder-picker"
import { ProviderPicker } from "@/components/provider-picker"
import {
  formatAskQuestionOutput,
  isOpenAskTool,
  type AskQuestionResult,
} from "@/components/ui/ask-question"
import { ChatInput, type ChatInputPayload } from "@/components/ui/chat-input"
import {
  ChatSidebar,
  ChatSidebarDnd,
  ChatSidebarItemGhost,
  ChatSidebarItemList,
  SideIconBtn,
  SideRow,
  SidebarCollapsibleSection,
  SidebarEmptyState,
  SidebarItemBadge,
  type ChatSidebarItemData,
} from "@/components/ui/chat-sidebar"
import type { GenerationStage } from "@/components/ui/generation-status"
import type { MessageToolCallData } from "@/components/ui/message"
import { MessageList } from "@/components/ui/message-list"
import {
  DEFAULT_MODEL_EFFORTS,
  ModelPicker,
  type ModelOption,
} from "@/components/ui/model-picker"
import {
  PromptSuggestions,
  type PromptSuggestion,
} from "@/components/ui/prompt-suggestions"
import { Skeleton } from "@/components/ui/skeleton"
import { ThemeToggle } from "@/components/ui/theme-toggle"
import * as api from "@/lib/api-client"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import { runLayoutTransition } from "@/lib/layout-transition"
import {
  applyStreamEvent,
  deriveSessionTitle,
  newId,
  seedAssistantMessage,
  toolsFromParts,
} from "@/lib/message-stream"
import type { AppSettings } from "@/lib/settings/schema"
import type { ProviderCapabilities, ProviderInfo } from "@/lib/providers/types"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"
import { cn } from "@/lib/utils"

const DESKTOP_QUERY = "(min-width: 768px)"
/** Last known sidebar index + open thread, so a reload paints before the fetch. */
const CACHE_INDEX_KEY = "agent-ui:sessions"
const CACHE_ACTIVE_KEY = "agent-ui:active-session"

const EMPTY_MESSAGES: StoredMessage[] = []

const SUGGESTIONS: PromptSuggestion[] = [
  { id: "streaming", label: "How does streaming work?", icon: <Waves /> },
  {
    id: "theming",
    label: "How do theme tokens work in dark mode?",
    icon: <Palette />,
  },
  {
    id: "composer",
    label: "What does the composer send when I attach a file?",
    icon: <Paperclip />,
  },
  {
    id: "markdown",
    label: "Walk me through the markdown, math and mermaid rendering",
    icon: <Sparkles />,
  },
  {
    id: "ask",
    label: "Use the ask tool so I can try the UI",
    icon: <HelpCircle />,
  },
]

type SessionRun = { startedAt: number; stage: GenerationStage }

const STAGE_SUBTITLES: Record<Exclude<GenerationStage, "idle">, string> = {
  thinking: "Thinking",
  searching: "Searching",
  responding: "Responding",
}

/** Wall clock read, hoisted out of the component so render stays pure. */
function nowMs() {
  return Date.now()
}

/** Compact sidebar timestamp — "now", "2m", "3h", "5d". */
function relativeTime(from: number, now: number) {
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 60) return "now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Elapsed wall time for a live Working label — "12s", "1m 04s". */
function formatElapsed(from: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}

/** Pinning floats a chat to the top; drag-to-reorder owns the order after that. */
function pinToTop(sessions: SessionMeta[], id: string) {
  const index = sessions.findIndex((session) => session.id === id)
  if (index < 0) return sessions
  const next = [...sessions]
  const [item] = next.splice(index, 1)
  return [{ ...item, pinned: true }, ...next]
}

/** Desktop-first so SSR and the first paint agree on the wide layout. */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = React.useState(true)

  React.useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY)
    const sync = () => setIsDesktop(mql.matches)
    sync()
    mql.addEventListener("change", sync)
    return () => mql.removeEventListener("change", sync)
  }, [])

  return isDesktop
}

function readCache<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeCache(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode / quota — the cache is only an optimization */
  }
}

/**
 * The chat surface. Deliberately a pure client component: sessions, providers
 * and settings are fetched from the app's routes after mount (seeded from a
 * localStorage snapshot so the sidebar paints immediately), and nothing on the
 * critical path waits on the server.
 */
export default function ChatPage() {
  const isDesktop = useIsDesktop()
  const [collapsed, setCollapsed] = React.useState(false)
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)
  const [chatsOpen, setChatsOpen] = React.useState(true)
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  /** Bumped to open the sidebar's inline rename for one chat. */
  const [renameRequest, setRenameRequest] = React.useState({
    id: "",
    token: 0,
  })

  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  const [providers, setProviders] = React.useState<ProviderInfo[]>([])
  const [providerId, setProviderId] = React.useState("")
  const [models, setModels] = React.useState<ModelOption[]>([])
  const [capabilities, setCapabilities] =
    React.useState<ProviderCapabilities | null>(null)
  const [model, setModel] = React.useState("")
  const [effort, setEffort] = React.useState("")

  const [sessions, setSessions] = React.useState<SessionMeta[]>([])
  const [activeId, setActiveId] = React.useState("")
  /** Thread bodies, loaded lazily per session. `undefined` = not loaded yet. */
  const [threads, setThreads] = React.useState<
    Record<string, StoredMessage[]>
  >({})
  const [runs, setRuns] = React.useState<Record<string, SessionRun>>({})
  const [failures, setFailures] = React.useState<Record<string, boolean>>({})
  /** False until the first `/api/sessions` answer — drives the list skeleton. */
  const [sessionsLoaded, setSessionsLoaded] = React.useState(false)

  const drawerTriggerRef = React.useRef<HTMLButtonElement>(null)
  const abortsRef = React.useRef(new Map<string, AbortController>())
  const threadsRef = React.useRef(threads)
  const activeIdRef = React.useRef(activeId)
  const inflightRef = React.useRef(new Set<string>())
  const bootstrappedRef = React.useRef(false)

  // Mirrors for the stable callbacks below — they run after paint, so a click
  // handler always reads the state the user is looking at.
  React.useEffect(() => {
    threadsRef.current = threads
    activeIdRef.current = activeId
  })

  const messages = threads[activeId] ?? EMPTY_MESSAGES
  const activeSession = sessions.find((session) => session.id === activeId)
  const activeRun = runs[activeId]
  const isGenerating = !!activeRun
  const threadLoading =
    !!activeId &&
    threads[activeId] === undefined &&
    (activeSession?.messageCount ?? 0) > 0
  const isEmptyChat = messages.length === 0 && !threadLoading
  const drawerOpen = mobileNavOpen && !isDesktop
  const pendingAsk = React.useMemo(
    () => findPendingAsk(messages) !== null,
    [messages]
  )

  /* ---------------------------------------------------------------------- */
  /* Loading                                                                 */
  /* ---------------------------------------------------------------------- */

  const loadThread = React.useCallback(async (id: string) => {
    if (!id) return
    if (threadsRef.current[id] !== undefined) return
    if (inflightRef.current.has(id)) return
    inflightRef.current.add(id)
    try {
      const loaded = await api.fetchMessages(id)
      // A run may have seeded the thread while this was in flight.
      setThreads((prev) =>
        prev[id] !== undefined ? prev : { ...prev, [id]: loaded }
      )
    } catch (err) {
      toast.error(errorMessage(err, "Could not load this chat"))
    } finally {
      inflightRef.current.delete(id)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false

    // Paint the last known sidebar before the network answers. Deferred to a
    // microtask (runs before the browser paints) so the effect body itself
    // stays setState-free for the strict react-hooks rules.
    const cachedActive = readCache<string>(CACHE_ACTIVE_KEY)
    queueMicrotask(() => {
      if (cancelled || bootstrappedRef.current) return
      const cachedSessions = readCache<SessionMeta[]>(CACHE_INDEX_KEY)
      if (!cachedSessions?.length) return
      setSessions(cachedSessions)
      const restored =
        cachedActive && cachedSessions.some((s) => s.id === cachedActive)
          ? cachedActive
          : cachedSessions[0].id
      setActiveId(restored)
    })

    void (async () => {
      const [settingsResult, providersResult, sessionsResult] =
        await Promise.allSettled([
          api.fetchSettings(),
          api.fetchProviders(),
          api.fetchSessions(),
        ])
      if (cancelled) return

      if (settingsResult.status === "fulfilled") {
        setSettings(settingsResult.value)
        setEffort(settingsResult.value.chat.defaultEffort)
      }

      if (providersResult.status === "fulfilled") {
        const list = providersResult.value
        setProviders(list)
        const preferred =
          settingsResult.status === "fulfilled"
            ? settingsResult.value.providers.active
            : ""
        setProviderId(pickProvider(list, preferred))
      } else {
        toast.error("Could not load providers")
      }

      setSessionsLoaded(true)
      if (sessionsResult.status === "fulfilled") {
        bootstrappedRef.current = true
        const list = sessionsResult.value
        setSessions(list)
        const restored =
          cachedActive && list.some((session) => session.id === cachedActive)
            ? cachedActive
            : (list[0]?.id ?? "")
        setActiveId(restored)
        if (restored) void loadThread(restored)
      } else {
        toast.error("Could not load your chats")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [loadThread])

  // Models follow the active provider; the current pick survives when it can.
  const defaultModel = settings?.chat.defaultModel ?? ""
  React.useEffect(() => {
    if (!providerId) return
    let cancelled = false
    api
      .fetchModels(providerId)
      .then((data) => {
        if (cancelled) return
        setModels(data.models)
        setCapabilities(data.capabilities ?? null)
        setModel((current) => {
          if (current && data.models.some((m) => m.id === current)) return current
          if (defaultModel && data.models.some((m) => m.id === defaultModel)) {
            return defaultModel
          }
          return data.models[0]?.id ?? ""
        })
        if (data.error) toast.error(data.error)
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(errorMessage(err, "Could not load models"))
      })
    return () => {
      cancelled = true
    }
  }, [providerId, defaultModel])

  React.useEffect(() => {
    if (!bootstrappedRef.current) return
    writeCache(CACHE_INDEX_KEY, sessions)
  }, [sessions])

  React.useEffect(() => {
    if (activeId) writeCache(CACHE_ACTIVE_KEY, activeId)
  }, [activeId])

  /** Closing the drawer hands focus back to the button that opened it. */
  const closeDrawer = React.useCallback(() => {
    setMobileNavOpen(false)
    drawerTriggerRef.current?.focus()
  }, [])

  // Escape closes the mobile drawer.
  React.useEffect(() => {
    if (!drawerOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [closeDrawer, drawerOpen])

  // The tab title follows the open chat.
  const activeTitle = activeSession?.title?.trim() ?? ""
  React.useEffect(() => {
    document.title = activeTitle ? `${activeTitle} — Agent UI` : "Agent UI"
  }, [activeTitle])

  React.useEffect(() => {
    const aborts = abortsRef.current
    return () => {
      for (const controller of aborts.values()) controller.abort()
      aborts.clear()
    }
  }, [])

  /* ---------------------------------------------------------------------- */
  /* Session mutations                                                       */
  /* ---------------------------------------------------------------------- */

  const patchLocal = React.useCallback(
    (id: string, patch: Partial<SessionMeta>) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === id ? { ...session, ...patch } : session
        )
      )
    },
    []
  )

  const selectSession = React.useCallback(
    (id: string) => {
      // Background chats keep streaming — selecting never aborts a run.
      setMobileNavOpen(false)
      const current = activeIdRef.current
      if (current !== id) {
        // Crossing between the centered opening and a thread slides the composer.
        const from = threadsRef.current[current]?.length ?? 0
        const to = threadsRef.current[id]?.length ?? 0
        if ((from === 0) !== (to === 0)) {
          runLayoutTransition(() => setActiveId(id))
        } else {
          setActiveId(id)
        }
      }
      void loadThread(id)
    },
    [loadThread]
  )

  const renameSession = React.useCallback(
    (id: string, title: string) => {
      patchLocal(id, { title, updatedAt: nowMs() })
      void api
        .patchSession(id, { title })
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not rename the chat"))
        )
    },
    [patchLocal]
  )

  /**
   * The chat's working folder. A chat that does not exist yet (the very first
   * one, before anything is sent) is created with the folder already on it, so
   * picking a folder is never lost.
   */
  const setFolder = React.useCallback(
    (next: { cwd: string; gitBranch: string }) => {
      const sessionId = activeIdRef.current
      if (!sessionId) {
        void api
          .createSession({ providerId, model, ...next })
          .then((created) => {
            setSessions((prev) => [created, ...prev])
            setThreads((prev) => ({ ...prev, [created.id]: [] }))
            setActiveId(created.id)
          })
          .catch((err: unknown) =>
            toast.error(errorMessage(err, "Could not start a new chat"))
          )
        return
      }
      patchLocal(sessionId, next)
      void api
        .patchSession(sessionId, next)
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not set the folder"))
        )
    },
    [model, patchLocal, providerId]
  )

  const togglePin = React.useCallback((id: string, pinned: boolean) => {
    setSessions((prev) =>
      pinned
        ? pinToTop(prev, id)
        : prev.map((session) =>
            session.id === id ? { ...session, pinned } : session
          )
    )
    void api
      .patchSession(id, pinned ? { pinned, order: 0 } : { pinned })
      .catch((err: unknown) =>
        toast.error(errorMessage(err, "Could not update the chat"))
      )
  }, [])

  const removeSession = React.useCallback((id: string) => {
    abortsRef.current.get(id)?.abort()
    abortsRef.current.delete(id)
    setThreads((prev) => {
      if (prev[id] === undefined) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setRuns((prev) => omit(prev, id))
    setFailures((prev) => omit(prev, id))
    setSessions((prev) => {
      const next = prev.filter((session) => session.id !== id)
      setActiveId((current) => (current === id ? (next[0]?.id ?? "") : current))
      return next
    })
    void api
      .deleteSession(id)
      .catch((err: unknown) =>
        toast.error(errorMessage(err, "Could not delete the chat"))
      )
  }, [])

  const handleNewChat = React.useCallback(async () => {
    setMobileNavOpen(false)
    const empty = sessions.find(
      (session) =>
        session.messageCount === 0 && (threadsRef.current[session.id]?.length ?? 0) === 0
    )
    if (empty) {
      selectSession(empty.id)
      return
    }
    try {
      const created = await api.createSession({ providerId, model })
      setSessions((prev) => [created, ...prev])
      setThreads((prev) => ({ ...prev, [created.id]: [] }))
      if (messages.length > 0) {
        runLayoutTransition(() => setActiveId(created.id))
      } else {
        setActiveId(created.id)
      }
    } catch (err) {
      toast.error(errorMessage(err, "Could not start a new chat"))
    }
  }, [messages.length, model, providerId, selectSession, sessions])

  /* ---------------------------------------------------------------------- */
  /* Running a turn                                                          */
  /* ---------------------------------------------------------------------- */

  const runPrompt = React.useCallback(
    async (args: {
      sessionId: string
      prompt: string
      prior: StoredMessage[]
      providerId: string
      model: string
      effort?: string
      animate?: boolean
      titleFrom?: string
    }) => {
      const { sessionId, prompt, prior } = args
      const startedAt = nowMs()
      const assistantId = newId()
      const userMessage: StoredMessage = {
        id: newId(),
        content: prompt,
        sender: "user",
        createdAt: startedAt,
      }
      const seeded = [...prior, userMessage, seedAssistantMessage(assistantId)]

      abortsRef.current.get(sessionId)?.abort()
      const controller = new AbortController()
      abortsRef.current.set(sessionId, controller)

      const paint = () => {
        setThreads((prev) => ({ ...prev, [sessionId]: seeded }))
        setRuns((prev) => ({
          ...prev,
          [sessionId]: { startedAt, stage: "thinking" },
        }))
        setFailures((prev) => omit(prev, sessionId))
      }
      if (args.animate) runLayoutTransition(paint)
      else paint()

      if (args.titleFrom) {
        patchLocal(sessionId, { title: deriveSessionTitle(args.titleFrom) })
      }
      patchLocal(sessionId, {
        providerId: args.providerId,
        model: args.model,
        updatedAt: startedAt,
        messageCount: seeded.length,
      })

      const patchAssistant = (
        updater: (message: StoredMessage) => StoredMessage
      ) => {
        setThreads((prev) => {
          const current = prev[sessionId]
          if (!current) return prev
          return {
            ...prev,
            [sessionId]: current.map((message) =>
              message.id === assistantId ? updater(message) : message
            ),
          }
        })
      }

      const setStage = (stage: GenerationStage) => {
        setRuns((prev) => {
          const run = prev[sessionId]
          if (!run || run.startedAt !== startedAt || run.stage === stage) {
            return prev
          }
          return { ...prev, [sessionId]: { ...run, stage } }
        })
      }

      const markFailed = () => {
        setFailures((prev) => ({ ...prev, [sessionId]: true }))
      }

      /**
       * Say why the turn stopped, in the turn itself. A message that already
       * has parts renders those and never its flat `content`, so a run that
       * died after some reasoning or a tool call used to leave a truncated
       * bubble and nothing but a toast that fades.
       */
      const failAssistant = (reason: string) => {
        drain()
        patchAssistant((message) =>
          message.content.trim()
            ? message
            : applyStreamEvent(message, {
                type: "text",
                text: `Agent error: ${reason}`,
              })
        )
        markFailed()
      }

      /**
       * Stream events land far faster than the browser can paint. Folding a
       * burst into one queued frame keeps the message list at one render per
       * frame instead of one per token, and the fold itself stays the shared
       * reducer so a reload of the thread still matches the live stream.
       */
      let queued: AgentStreamEvent[] = []
      let frame = 0
      const flush = () => {
        frame = 0
        const batch = queued
        queued = []
        /**
         * Aborting is not a reason to drop what already arrived: Stop leaves
         * the turn in place and the server persists every event it produced,
         * so swallowing the last frame would make a reload grow the answer.
         * A run that was superseded is safe on its own — `patchAssistant` is
         * keyed on `assistantId`, which the re-seeded thread no longer holds.
         */
        if (batch.length === 0) return
        patchAssistant((message) =>
          batch.reduce(
            (current, event) => applyStreamEvent(current, event),
            message
          )
        )
      }
      const enqueue = (event: AgentStreamEvent) => {
        queued.push(event)
        if (frame) return
        frame =
          typeof requestAnimationFrame === "function"
            ? requestAnimationFrame(flush)
            : (setTimeout(flush, 16) as unknown as number)
      }
      /** Run-level events must not overtake the text they follow. */
      const drain = () => {
        if (frame) {
          if (typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(frame)
          } else {
            clearTimeout(frame)
          }
        }
        flush()
      }

      const onEvent = (event: AgentStreamEvent) => {
        if (controller.signal.aborted) return
        if (event.type === "session") {
          patchLocal(sessionId, { providerSessionId: event.sessionId })
          return
        }
        if (event.type === "error") {
          toast.error(event.message)
          failAssistant(event.message)
          return
        }
        if (event.type === "done") {
          drain()
          /**
           * Labels the turn's "Worked for 12s" row. The provider's own
           * `durationMs` wins over the wall clock for the same reason the
           * chat route prefers it when persisting: otherwise the number the
           * turn shows live would shift the moment the thread is reloaded.
           */
          const elapsed = (event.durationMs ?? nowMs() - startedAt) / 1000
          patchAssistant((message) => ({
            ...message,
            workedFor: elapsed,
            metadata: {
              model: args.model,
              providerId: args.providerId,
              responseTime: elapsed,
            },
          }))
          if (event.sessionId) {
            patchLocal(sessionId, { providerSessionId: event.sessionId })
          }
          return
        }
        if (event.type === "thinking") setStage("thinking")
        else if (event.type === "text") setStage("responding")
        else if (event.type === "tool") setStage("searching")
        enqueue(event)
      }

      try {
        await api.streamChat(
          {
            prompt,
            providerId: args.providerId,
            model: args.model,
            sessionId,
            effort: args.effort,
            userMessageId: userMessage.id,
            assistantMessageId: assistantId,
          },
          { onEvent, signal: controller.signal }
        )
      } catch (err) {
        if (!controller.signal.aborted) {
          const message = errorMessage(err, "The agent run failed")
          toast.error(message)
          failAssistant(message)
        }
      } finally {
        drain()
        if (abortsRef.current.get(sessionId) === controller) {
          abortsRef.current.delete(sessionId)
        }
        setRuns((prev) =>
          prev[sessionId]?.startedAt === startedAt ? omit(prev, sessionId) : prev
        )
        patchLocal(sessionId, { updatedAt: nowMs() })
      }
    },
    [patchLocal]
  )

  const send = React.useCallback(
    async (text: string, files: File[], skills: string[]) => {
      const trimmed = text.trim()
      if (!trimmed) return

      let sessionId = activeId
      let prior = threadsRef.current[sessionId] ?? EMPTY_MESSAGES

      if (trimmed === "/clear") {
        if (!sessionId) return
        abortsRef.current.get(sessionId)?.abort()
        setRuns((prev) => omit(prev, sessionId))
        setFailures((prev) => omit(prev, sessionId))
        runLayoutTransition(() =>
          setThreads((prev) => ({ ...prev, [sessionId]: [] }))
        )
        patchLocal(sessionId, { messageCount: 0, providerSessionId: "" })
        void api
          .putMessages(sessionId, [])
          .then(() => api.patchSession(sessionId, { providerSessionId: "" }))
          .catch((err: unknown) =>
            toast.error(errorMessage(err, "Could not clear the chat"))
          )
        return
      }

      const skillPrefix = skills.length > 0 ? `[skills: ${skills.join(", ")}] ` : ""
      const fileNote =
        files.length > 0
          ? `\n\nAttached: ${files.map((file) => file.name).join(", ")}`
          : ""
      const content = `${skillPrefix}${text}${fileNote}`

      if (!sessionId) {
        try {
          const created = await api.createSession({ providerId, model })
          sessionId = created.id
          prior = EMPTY_MESSAGES
          setSessions((prev) => [created, ...prev])
          setThreads((prev) => ({ ...prev, [created.id]: [] }))
          setActiveId(created.id)
        } catch (err) {
          toast.error(errorMessage(err, "Could not start a new chat"))
          return
        }
      }

      // An unanswered ask block is treated as skipped once the user types on.
      const pending = findPendingAsk(prior)
      if (pending) {
        prior = completeAsk(prior, pending.messageId, pending.toolId, {
          skipped: true,
          answers: {},
        })
        setThreads((prev) => ({ ...prev, [sessionId]: prior }))
        await api
          .putMessages(sessionId, prior)
          .catch(() => {
            /* the run below rewrites the thread anyway */
          })
      }

      const session = sessions.find((item) => item.id === sessionId)
      void runPrompt({
        sessionId,
        prompt: content,
        prior,
        providerId,
        model,
        effort: capabilities?.effort ? effort : undefined,
        animate: prior.length === 0,
        titleFrom:
          prior.length === 0 &&
          (settings?.chat.autoTitle ?? true) &&
          (!session?.title || session.title === "New chat")
            ? content
            : undefined,
      })
    },
    [
      activeId,
      capabilities?.effort,
      effort,
      model,
      patchLocal,
      providerId,
      runPrompt,
      sessions,
      settings?.chat.autoTitle,
    ]
  )

  const handleSend = React.useCallback(
    (payload: ChatInputPayload) => {
      void send(payload.text, payload.files, payload.skills)
    },
    [send]
  )

  const handleStop = React.useCallback(() => {
    abortsRef.current.get(activeId)?.abort()
    abortsRef.current.delete(activeId)
    setRuns((prev) => omit(prev, activeId))
  }, [activeId])

  /** Rewrites the stored thread after an in-place edit / delete / ask answer. */
  const commitThread = React.useCallback(
    async (sessionId: string, next: StoredMessage[]) => {
      setThreads((prev) => ({ ...prev, [sessionId]: next }))
      patchLocal(sessionId, { messageCount: next.length, updatedAt: nowMs() })
      try {
        await api.putMessages(sessionId, next)
      } catch (err) {
        toast.error(errorMessage(err, "Could not save the chat"))
      }
    },
    [patchLocal]
  )

  const handleAskAnswer = React.useCallback(
    (messageId: string, toolId: string, result: AskQuestionResult) => {
      const sessionId = activeId
      const next = completeAsk(
        threadsRef.current[sessionId] ?? EMPTY_MESSAGES,
        messageId,
        toolId,
        result
      )
      void (async () => {
        await commitThread(sessionId, next)
        await runPrompt({
          sessionId,
          prompt: result.skipped
            ? "AskQuestion result: skipped"
            : `AskQuestion result: ${JSON.stringify(result.answers)}`,
          prior: next,
          providerId,
          model,
          effort: capabilities?.effort ? effort : undefined,
        })
      })()
    },
    [activeId, capabilities?.effort, commitThread, effort, model, providerId, runPrompt]
  )

  const handleEditMessage = React.useCallback(
    (id: string, content: string) => {
      const sessionId = activeId
      const next = (threadsRef.current[sessionId] ?? EMPTY_MESSAGES).map(
        (message) => (message.id === id ? { ...message, content } : message)
      )
      void commitThread(sessionId, next)
    },
    [activeId, commitThread]
  )

  /** Drops the assistant turn and re-runs the user prompt above it. */
  const handleRegenerate = React.useCallback(
    (messageId: string) => {
      const sessionId = activeId
      const current = threadsRef.current[sessionId] ?? EMPTY_MESSAGES
      const index = current.findIndex((message) => message.id === messageId)
      let userIndex = index - 1
      while (userIndex >= 0 && current[userIndex].sender !== "user") userIndex--
      if (userIndex < 0) return
      const prompt = current[userIndex].content
      /**
       * Everything from the user turn down goes, question included: the run
       * below re-appends it — once in the optimistic thread, once server-side
       * — so keeping it here would leave the prompt duplicated in the UI and
       * on disk.
       */
      const next = current.slice(0, userIndex)
      void (async () => {
        await commitThread(sessionId, next)
        await runPrompt({
          sessionId,
          prompt,
          prior: next,
          providerId,
          model,
          effort: capabilities?.effort ? effort : undefined,
        })
      })()
    },
    [activeId, capabilities?.effort, commitThread, effort, model, providerId, runPrompt]
  )

  const handleDeleteMessage = React.useCallback(
    (messageId: string) => {
      const sessionId = activeId
      const next = (threadsRef.current[sessionId] ?? EMPTY_MESSAGES).filter(
        (message) => message.id !== messageId
      )
      void commitThread(sessionId, next)
    },
    [activeId, commitThread]
  )

  /* ---------------------------------------------------------------------- */
  /* Derived view models                                                     */
  /* ---------------------------------------------------------------------- */

  const providerName = React.useCallback(
    (id: string) => providers.find((item) => item.id === id)?.name ?? id,
    [providers]
  )

  const sessionItems = React.useMemo<ChatSidebarItemData[]>(
    () =>
      sessions.map((session) => {
        const run = runs[session.id]
        const subtitle = run
          ? STAGE_SUBTITLES[run.stage === "idle" ? "thinking" : run.stage]
          : session.cwd
            ? // A chat pinned to a folder says where it works — that places it
              // faster than the model it happens to be using.
              <SidebarItemBadge
                folder={session.cwd}
                branch={session.gitBranch}
              />
            : session.messageCount === 0
              ? "New chat"
              : [
                  providerName(session.providerId),
                  session.providerId === providerId
                    ? (models.find((m) => m.id === session.model)?.name ??
                      session.model)
                    : session.model,
                ]
                  .filter(Boolean)
                  .join(" · ")
        return {
          id: session.id,
          title: session.title,
          pinned: session.pinned,
          status: run ? "streaming" : failures[session.id] ? "fault" : undefined,
          subtitle,
          meta: run ? (
            <WorkingFor startedAt={run.startedAt} dim={session.id !== activeId} />
          ) : failures[session.id] ? (
            <span className="font-medium text-destructive">Failed</span>
          ) : (
            <RelativeTime from={session.updatedAt} />
          ),
        }
      }),
    [activeId, failures, models, providerId, providerName, runs, sessions]
  )

  const paletteSessions = React.useMemo<CommandPaletteSession[]>(
    () =>
      sessions.map((session) => ({
        id: session.id,
        title: session.title || "Untitled",
        meta: [providerName(session.providerId), session.model]
          .filter(Boolean)
          .join(" · "),
      })),
    [providerName, sessions]
  )

  /** Palette → the sidebar's inline rename input for that chat. */
  const startRename = React.useCallback(
    (id: string) => {
      if (isDesktop) setCollapsed(false)
      else setMobileNavOpen(true)
      setChatsOpen(true)
      setRenameRequest((prev) => ({ id, token: prev.token + 1 }))
    },
    [isDesktop]
  )

  const showEfforts =
    !!capabilities?.effort && (settings?.chat.defaultEffort ?? "") !== ""

  const activeProviderName = providers.find(
    (item) => item.id === providerId
  )?.name

  /**
   * The composer holds the draft the user is typing and has nothing to do with
   * the answer streaming above it, so it is kept off the per-frame render path.
   */
  const composer = React.useMemo(
    () => (
      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        isGenerating={isGenerating}
        placeholder={
          pendingAsk
            ? "Add more optional details…"
            : activeProviderName
              ? `Ask ${activeProviderName}…`
              : "Ask anything"
        }
        /* The composer already measures like the message column; the empty
           chat only closes the gap under it, since the suggestions land there. */
        className={cn(
          "transition-[padding] duration-300 ease-out",
          isEmptyChat && "pb-0 sm:pb-0"
        )}
        tools={
          <>
            <ProviderPicker
              providers={providers}
              value={providerId}
              onChange={setProviderId}
            />
            <ModelPicker
              value={model}
              onChange={setModel}
              options={models}
              efforts={showEfforts ? DEFAULT_MODEL_EFFORTS : false}
              effort={effort}
              onEffortChange={setEffort}
              side="top"
              className="min-w-0"
            />
          </>
        }
      />
    ),
    [
      activeProviderName,
      effort,
      handleSend,
      handleStop,
      isEmptyChat,
      isGenerating,
      model,
      models,
      pendingAsk,
      providerId,
      providers,
      showEfforts,
    ]
  )

  /**
   * The chat list only moves when a session does; keeping it out of the render
   * the streaming turn drives means the sidebar is not rebuilt every frame.
   */
  const sidebar = React.useMemo(
    () => (
      <ChatSidebarDnd
        onDrop={(drop) => {
          if (drop.kind === "reorder") {
            setSessions((prev) => arrayMove(prev, drop.from, drop.to))
            const moved = sessions[drop.from]
            if (moved) {
              void api
                .patchSession(moved.id, { order: drop.to })
                .catch((err: unknown) =>
                  toast.error(errorMessage(err, "Could not reorder chats"))
                )
            }
          } else if (drop.action === "pin") {
            togglePin(drop.itemId, true)
          } else if (drop.action === "delete") {
            removeSession(drop.itemId)
            toast.message("Chat deleted")
          }
        }}
        renderOverlay={(id) => {
          const item = sessionItems.find((session) => session.id === id)
          if (!item) return null
          return <ChatSidebarItemGhost item={item} active={item.id === activeId} />
        }}
      >
        <ChatSidebar
          collapsed={isDesktop ? collapsed : false}
          onCollapsedChange={(next) =>
            isDesktop ? setCollapsed(next) : closeDrawer()
          }
          edgeZones
          brand={
            <span className="truncate px-1 text-[15px] font-semibold tracking-tight text-foreground">
              Chats
            </span>
          }
          nav={
            <>
              <SideRow
                icon={<Pencil className="size-4" />}
                onClick={() => void handleNewChat()}
              >
                New chat
              </SideRow>
              <SideRow
                icon={<Search className="size-4" />}
                hint="⌘K"
                onClick={() => setPaletteOpen(true)}
              >
                Search chats
              </SideRow>
            </>
          }
          rail={
            <>
              <SideIconBtn
                label="New chat"
                onClick={() => void handleNewChat()}
              >
                <Pencil className="size-4" />
              </SideIconBtn>
              <SideIconBtn
                label="Search chats"
                onClick={() => setPaletteOpen(true)}
              >
                <Search className="size-4" />
              </SideIconBtn>
            </>
          }
        >
          <SidebarSessionSection
            open={chatsOpen}
            onToggle={() => setChatsOpen((value) => !value)}
            sessions={sessionItems}
            loading={!sessionsLoaded && sessionItems.length === 0}
            activeId={activeId}
            renameRequest={renameRequest}
            onSelect={selectSession}
            onRename={renameSession}
            onTogglePin={togglePin}
            onDelete={removeSession}
          />
        </ChatSidebar>
      </ChatSidebarDnd>
    ),
    [
      activeId,
      chatsOpen,
      collapsed,
      handleNewChat,
      isDesktop,
      closeDrawer,
      removeSession,
      renameRequest,
      renameSession,
      selectSession,
      sessionItems,
      sessions,
      sessionsLoaded,
      togglePin,
    ]
  )

  return (
    <div className="relative flex h-svh min-h-0 overflow-hidden bg-background">
      {/* Below md the sidebar slides over the conversation instead of squeezing it. */}
      <div
        aria-hidden={!drawerOpen}
        onClick={closeDrawer}
        className={cn(
          "absolute inset-0 z-40 bg-foreground/20 backdrop-blur-[1px] transition-opacity duration-200 motion-reduce:transition-none md:hidden",
          drawerOpen ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <div
        // Off-canvas below md: keep the hidden drawer out of the tab order.
        inert={!isDesktop && !drawerOpen}
        className={cn(
          "z-50 h-full shrink-0 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:shadow-xl max-md:transition-transform max-md:duration-200 max-md:motion-reduce:transition-none md:relative",
          !drawerOpen && "max-md:-translate-x-full"
        )}
      >
        {sidebar}
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <AppHeader>
          <button
            ref={drawerTriggerRef}
            type="button"
            aria-label="Open chats"
            aria-expanded={drawerOpen}
            title="Open chats"
            onClick={() => setMobileNavOpen(true)}
            className="-ml-1 inline-grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden [&_svg]:size-4"
          >
            <PanelLeft />
          </button>
          <AppHeaderBrand />
          <AppHeaderTitle
            title={activeSession?.title ?? "New chat"}
            generating={isGenerating}
            stage={activeRun?.stage ?? "thinking"}
          >
            <FolderPicker
              cwd={activeSession?.cwd}
              gitBranch={activeSession?.gitBranch}
              onChange={setFolder}
            />
          </AppHeaderTitle>
          <AppHeaderActions>
            <AppHeaderButton
              label="Search chats and commands"
              hint="⌘K"
              onClick={() => setPaletteOpen(true)}
            >
              <Search />
            </AppHeaderButton>
            <AppHeaderButton label="Settings" href="/settings">
              <SettingsIcon />
            </AppHeaderButton>
            <ThemeToggle
              floating={false}
              className="size-8 rounded-md border-0 bg-transparent text-muted-foreground shadow-none hover:bg-muted hover:text-foreground"
            />
          </AppHeaderActions>
        </AppHeader>

        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-x-hidden",
            isEmptyChat && "justify-center"
          )}
        >
          {threadLoading ? (
            <ThreadLoading />
          ) : isEmptyChat ? (
            <div
              data-slot="chat-opening"
              className="mx-auto w-full max-w-3xl px-3 pb-5 sm:px-4"
            >
              <h2 className="text-center text-2xl font-semibold tracking-tight text-balance text-foreground sm:text-3xl">
                How can I help?
              </h2>
            </div>
          ) : (
            <MessageList
              messages={messages}
              isGenerating={isGenerating}
              generationStage={activeRun?.stage ?? "idle"}
              onEditMessage={handleEditMessage}
              onAskAnswer={handleAskAnswer}
              renderActions={(message) =>
                message.sender === "assistant" ? (
                  <MessageActions
                    messageId={message.id}
                    content={message.content}
                    onRegenerate={handleRegenerate}
                    onDelete={handleDeleteMessage}
                  />
                ) : null
              }
            />
          )}

          <div data-slot="chat-composer" className="w-full shrink-0">
            {composer}
            {isEmptyChat && (settings?.chat.showSuggestions ?? true) ? (
              <PromptSuggestions
                items={SUGGESTIONS}
                onSelect={(item) => void send(item.label, [], [])}
              />
            ) : null}
          </div>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sessions={paletteSessions}
        activeId={activeId}
        onSelectSession={selectSession}
        onNewChat={() => void handleNewChat()}
        onRenameSession={startRename}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A live label owns its own tick. A single page-level clock re-rendered the
 * whole app — sidebar, composer and message list included — once a second for
 * the sake of one "12s" string.
 */
function useTick(everyMs: number) {
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
}

const WorkingFor = React.memo(function WorkingFor({
  startedAt,
  dim,
}: {
  startedAt: number
  dim: boolean
}) {
  useTick(1_000)
  return (
    <span className={cn("font-medium text-primary", dim && "opacity-75")}>
      Working · {formatElapsed(startedAt, nowMs())}
    </span>
  )
})

const RelativeTime = React.memo(function RelativeTime({ from }: { from: number }) {
  useTick(30_000)
  return <>{relativeTime(from, nowMs())}</>
})

/** Cold start: the chat list is still in flight, so show rows, not "empty". */
const SidebarLoading = React.memo(function SidebarLoading() {
  return (
    <div aria-busy className="flex flex-col gap-1 px-1 py-1">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-9 w-full opacity-40" />
      ))}
    </div>
  )
})

/** The transcript of a chat that is being read back from disk. */
const ThreadLoading = React.memo(function ThreadLoading() {
  return (
    <div
      aria-busy
      aria-label="Loading the chat"
      className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col gap-7 overflow-hidden px-3 py-6 sm:px-4"
    >
      {[0, 1].map((turn) => (
        <React.Fragment key={turn}>
          <Skeleton className="ml-auto h-9 w-56 rounded-2xl opacity-40" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-[85%] opacity-30" />
            <Skeleton className="h-3.5 w-[70%] opacity-30" />
            <Skeleton className="h-3.5 w-[45%] opacity-30" />
          </div>
        </React.Fragment>
      ))}
    </div>
  )
})

const SidebarSessionSection = React.memo(function SidebarSessionSection({
  open,
  onToggle,
  sessions,
  loading,
  activeId,
  renameRequest,
  onSelect,
  onRename,
  onTogglePin,
  onDelete,
}: {
  open: boolean
  onToggle: () => void
  sessions: ChatSidebarItemData[]
  /** First fetch still in flight — "New chats appear here" would be a lie. */
  loading: boolean
  activeId: string
  renameRequest: { id: string; token: number }
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
  onDelete: (id: string) => void
}) {
  return (
    <SidebarCollapsibleSection
      title="Recent chats"
      open={open}
      onToggle={onToggle}
      count={sessions.length}
    >
      <ChatSidebarItemList
        items={sessions}
        activeId={activeId}
        listId="recent"
        renameRequest={renameRequest}
        sortable
        emptyState={
          loading ? (
            <SidebarLoading />
          ) : (
            <SidebarEmptyState>New chats appear here.</SidebarEmptyState>
          )
        }
        onSelect={onSelect}
        onRename={onRename}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
      />
    </SidebarCollapsibleSection>
  )
})

const MessageActions = React.memo(function MessageActions({
  messageId,
  content,
  onRegenerate,
  onDelete,
}: {
  messageId: string
  content: string
  onRegenerate: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="-mt-2 mb-4 flex gap-1 opacity-60 transition-opacity focus-within:opacity-100 hover:opacity-100">
      <ActionBtn
        title="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(content)
          toast.success("Copied")
        }}
      >
        <Copy />
      </ActionBtn>
      <ActionBtn title="Regenerate" onClick={() => onRegenerate(messageId)}>
        <RefreshCw />
      </ActionBtn>
      <ActionBtn title="Delete" onClick={() => onDelete(messageId)}>
        <Trash2 />
      </ActionBtn>
    </div>
  )
})

function ActionBtn({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="inline-grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function pickProvider(list: ProviderInfo[], preferred: string) {
  const wanted = list.find((item) => item.id === preferred)
  if (wanted?.available) return wanted.id
  return list.find((item) => item.available)?.id ?? preferred ?? ""
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (record[key] === undefined) return record
  const next = { ...record }
  delete next[key]
  return next
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback
}

/**
 * Only the latest turn can still be waiting on an answer — matching the row
 * `MessageList` offers a form for. An unanswered ask further back is history,
 * and picking it up here would rewrite a stored transcript the user closed
 * long ago.
 */
function findPendingAsk(messages: StoredMessage[]) {
  const message = messages.at(-1)
  if (!message) return null
  const tools = message.tools?.length
    ? message.tools
    : toolsFromParts(message.parts ?? [])
  const tool = tools.find(isOpenAskTool)
  return tool ? { messageId: message.id, toolId: tool.id } : null
}

function completeAsk(
  messages: StoredMessage[],
  messageId: string,
  toolId: string,
  result: AskQuestionResult
): StoredMessage[] {
  const output = formatAskQuestionOutput(result)
  return messages.map((message) => {
    if (message.id !== messageId) return message
    const patchTool = (tool: MessageToolCallData) =>
      tool.id === toolId ? { ...tool, status: "done" as const, output } : tool
    return {
      ...message,
      tools: message.tools?.map(patchTool),
      parts: message.parts?.map((part) =>
        part.type === "tool" && part.tool.id === toolId
          ? { ...part, tool: patchTool(part.tool) }
          : part
      ),
    }
  })
}
