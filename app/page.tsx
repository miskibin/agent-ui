"use client"

import { arrayMove } from "@dnd-kit/sortable"
import {
  HelpCircle,
  Palette,
  PanelLeft,
  Paperclip,
  Pencil,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Waves,
} from "lucide-react"
import { useRouter } from "next/navigation"
import * as React from "react"
import { type Layout } from "react-resizable-panels"
import { toast } from "sonner"

import {
  AppHeader,
  AppHeaderActions,
  AppHeaderButton,
} from "@/components/app-header"
import {
  CommandPalette,
  type CommandPaletteSession,
} from "@/components/command-palette"
import {
  ContextUsage,
  contextTurnUsage,
  useDraftStore,
} from "@/components/context-usage"
import { FolderPicker } from "@/components/folder-picker"
import { HandoffNotice } from "@/components/handoff-notice"
import { MemoryNotice } from "@/components/memory-notice"
import { MessageActions } from "@/components/message-actions"
import { PermissionPicker } from "@/components/permission-picker"
import { ProviderLogo } from "@/components/provider-logo"
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
  SidebarItemStatusDot,
  type ChatSidebarItemData,
} from "@/components/ui/chat-sidebar"
import {
  FilePreview,
  filePreviewFromTool,
  type FilePreviewFile,
} from "@/components/ui/file-preview"
import type { GenerationStage } from "@/components/ui/generation-status"
import type {
  ChangeSummaryFile,
  MessageAttachmentData,
  MessageToolCallData,
} from "@/components/ui/message"
import { MessageList } from "@/components/ui/message-list"
import { isImagePath } from "@/components/ui/message-parts"
import {
  DEFAULT_MODEL_EFFORTS,
  ModelPicker,
  type ModelOption,
  type ModelPickerGroup,
} from "@/components/ui/model-picker"
import {
  PromptSuggestions,
  type PromptSuggestion,
} from "@/components/ui/prompt-suggestions"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Skeleton } from "@/components/ui/skeleton"
import { ThemeToggle } from "@/components/ui/theme-toggle"
import {
  TodoPanel,
  isTodoToolName,
  parseTodoItems,
  type TodoItem,
} from "@/components/ui/todo-list"
import * as api from "@/lib/api-client"
import {
  MAX_IMAGE_BYTES,
  isImageFile,
  readFileAsDataUrl,
} from "@/lib/attachments"
import type {
  AgentStatusStage,
  AgentStreamEvent,
} from "@/lib/cursor-agent-types"
import { runLayoutTransition } from "@/lib/layout-transition"
import { localFileUrlFrom } from "@/lib/local-media"
import {
  applyStreamEvent,
  deriveSessionTitle,
  newId,
  seedAssistantMessage,
  toolsFromParts,
} from "@/lib/message-stream"
import { joinModelId } from "@/lib/model-providers/ids"
import {
  PINNED_GROUP_ID,
  groupIdForSession,
  groupSessions,
  type SessionGroup,
} from "@/lib/session-groups"
import { turnFiles } from "@/lib/turn-files"
import { playAgentNotificationSound } from "@/lib/notification-sounds"
import { providerSessionHints } from "@/lib/handoff/types"
import type { TurnStateFrame } from "@/lib/handoff/types"
import type { MemoryChange } from "@/lib/memory/types"
import type { AppSettings } from "@/lib/settings/schema"
import type {
  PermissionMode,
  ProviderCapabilities,
  ProviderInfo,
} from "@/lib/providers/types"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"
import { cn } from "@/lib/utils"

const DESKTOP_QUERY = "(min-width: 768px)"
/** Last known sidebar index + open thread, so a reload paints before the fetch. */
const CACHE_INDEX_KEY = "agent-ui:sessions"
const CACHE_ACTIVE_KEY = "agent-ui:active-session"
/** Active/running transcripts plus this many recently opened bodies stay hot. */
const MAX_CACHED_THREADS = 4

/** Where the dragged file-panel width is remembered, as a percentage. */
const CACHE_SPLIT_KEY = "agent-ui:preview-size"

/**
 * Which sidebar folder sections the user closed, keyed by group id. Only the
 * closed ones are worth remembering: a folder seen for the first time — a chat
 * that just picked one — should open, not hide.
 */
const CACHE_SECTIONS_KEY = "agent-ui:folder-sections"

/** The conversation and the file panel are the two panes of one split. */
const WORKSPACE_GROUP_ID = "chat-workspace"
const CHAT_PANEL_ID = "chat"
const PREVIEW_PANEL_ID = "preview"
const DEFAULT_PREVIEW_SIZE = 35
const MIN_PREVIEW_SIZE = 20
const MAX_PREVIEW_SIZE = 60

const EMPTY_MESSAGES: StoredMessage[] = []
const EMPTY_TODOS: TodoItem[] = []
/** Stable identity for "this harness offers no permission choice". */
const EMPTY_PERMISSION_MODES: PermissionMode[] = []

/**
 * What the composer shows when the harness reports no default of its own.
 * Display only — see `effectivePermission`.
 */
const FALLBACK_PERMISSION_MODE: PermissionMode = "full"

/**
 * The newest plan in a thread, whoever wrote it — a `todo_write`-style tool
 * from the harness, or an ACP `plan` update that `lib/acp-agent.ts` folds into
 * the same tool arguments. Derived from the transcript rather than tracked
 * alongside it, so a reloaded chat shows the plan the live turn ended on.
 */
function latestTodos(messages: StoredMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts
    if (!parts) continue
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (part.type !== "tool" || !isTodoToolName(part.tool.name)) continue
      const items = parseTodoItems(part.tool.input)
      if (items) return items
    }
  }
  return EMPTY_TODOS
}

/** How an answered Ask Question block is handed back to the model. */
const ASK_ANSWER_PREFIX = "AskQuestion result: "
const ASK_ANSWER_SKIPPED = `${ASK_ANSWER_PREFIX}skipped`

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

type SessionRun = {
  startedAt: number
  stage: GenerationStage
  /**
   * Latest `status` line from the backend — "Loading qwen3:8b into memory ·
   * 24s". Shown instead of the stage word, and dropped the moment real output
   * arrives, because by then the stage word is true again.
   */
  status?: string
}

const STAGE_SUBTITLES: Record<Exclude<GenerationStage, "idle">, string> = {
  thinking: "Thinking",
  searching: "Searching",
  responding: "Responding",
}

/**
 * `AgentStatusStage` is finer than the indicator's three stages: setup phases
 * have no dot of their own, and read as thinking.
 */
function statusStage(stage: AgentStatusStage | undefined): GenerationStage {
  return stage === "searching" || stage === "responding" ? stage : "thinking"
}

/** The empty-state section has nothing to fold, so its trigger does nothing. */
function noop() {}

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

/** Percentage of the workspace the file panel had last time, if it is sane. */
function readPreviewSize() {
  const raw = readCache<number>(CACHE_SPLIT_KEY)
  return typeof raw === "number" &&
    Number.isFinite(raw) &&
    raw >= MIN_PREVIEW_SIZE &&
    raw <= MAX_PREVIEW_SIZE
    ? raw
    : null
}

/**
 * The chat surface. Deliberately a pure client component: sessions, providers
 * and settings are fetched from the app's routes after mount (seeded from a
 * localStorage snapshot so the sidebar paints immediately), and nothing on the
 * critical path waits on the server.
 */
/** The vendored toggle, dressed as a sidebar icon button. */
const SIDEBAR_THEME_TOGGLE =
  "size-8 rounded-md border-0 bg-transparent text-muted-foreground shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"

export default function ChatPage() {
  const router = useRouter()
  const isDesktop = useIsDesktop()
  const [collapsed, setCollapsed] = React.useState(false)
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)
  /** Sections the user closed. Absent id = open, so a new folder shows up. */
  const [closedSections, setClosedSections] = React.useState<
    Record<string, boolean>
  >({})
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  /** Bumped to open the sidebar's inline rename for one chat. */
  const [renameRequest, setRenameRequest] = React.useState({
    id: "",
    token: 0,
  })

  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  /**
   * The last memory update per chat, shown as a marker in the thread. Keyed by
   * session so switching chats mid-extraction cannot show one chat's changes
   * under another's last turn.
   */
  const [memoryNotices, setMemoryNotices] = React.useState<
    Record<string, { changes: MemoryChange[]; compacted?: boolean }>
  >({})
  const [providers, setProviders] = React.useState<ProviderInfo[]>([])
  const [providerId, setProviderId] = React.useState("")
  const [models, setModels] = React.useState<ModelOption[]>([])
  /**
   * Picker sections for the active provider, in order — empty for a provider
   * that serves models from a single source.
   */
  const [modelGroups, setModelGroups] = React.useState<
    Array<{ id: string; label: string }>
  >([])
  const [capabilities, setCapabilities] =
    React.useState<ProviderCapabilities | null>(null)
  /** Model ids the active provider says take image input — empty until it says otherwise. */
  const [visionModels, setVisionModels] = React.useState<string[]>([])
  const [model, setModel] = React.useState("")
  const [effort, setEffort] = React.useState("")
  /**
   * The open chat's stored permission pick, or "" for "never chosen". The mode
   * a turn actually runs under is derived from this and the harness's own list
   * (`chosenPermission` below), so a provider switch cannot leave the
   * composer showing a mode the new harness does not offer.
   */
  const [permissionMode, setPermissionMode] = React.useState("")
  /** The modes the active harness can enforce; empty = it offers no choice. */
  const permissionModes =
    capabilities?.permissionModes ?? EMPTY_PERMISSION_MODES
  /**
   * The mode this chat's turns are *sent* under — an explicit pick, and only
   * that. `""` (nothing chosen, or a pick this harness does not offer) keeps
   * the field out of the request entirely, which every provider already reads
   * as "whatever settings say". Synthesizing a default here would hand the
   * harness a policy the user never chose, widening both the ACP approval
   * policy and, for dsh, the sandbox its process is spawned into.
   */
  const chosenPermission: PermissionMode | "" = permissionModes.includes(
    permissionMode as PermissionMode
  )
    ? (permissionMode as PermissionMode)
    : ""
  /**
   * What the composer *displays*: the pick, else the policy the harness says
   * it already runs under. Display only — never sent.
   */
  const effectivePermission: PermissionMode | "" =
    chosenPermission ||
    (permissionModes.length === 0
      ? ""
      : (capabilities?.defaultPermissionMode ?? FALLBACK_PERMISSION_MODE))

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
  /** The file open in the right-hand panel; null = the panel is closed. */
  const [preview, setPreview] = React.useState<FilePreviewFile | null>(null)
  // Where the divider was last dragged to. Read after mount, not during
  // render: the pane it sizes is not on screen yet, and localStorage does not
  // exist while the page prerenders.
  const [previewSize, setPreviewSize] = React.useState(DEFAULT_PREVIEW_SIZE)

  const drawerTriggerRef = React.useRef<HTMLButtonElement>(null)
  const abortsRef = React.useRef(new Map<string, AbortController>())
  const threadsRef = React.useRef(threads)
  const activeIdRef = React.useRef(activeId)
  const sessionsRef = React.useRef(sessions)
  const providersRef = React.useRef(providers)
  const providerIdRef = React.useRef(providerId)
  const modelRef = React.useRef(model)
  const inflightRef = React.useRef(new Set<string>())
  const threadAccessRef = React.useRef<string[]>([])
  const bootstrappedRef = React.useRef(false)
  /**
   * The provider the user just picked, until its model list lands. Only that
   * pick may rewrite the chat's stored model — the same resolution running for
   * a chat that was merely opened must leave the chat's own agent alone.
   */
  const providerPickRef = React.useRef("")
  /** Read by `runPrompt`, which must not re-create itself when settings land. */
  const settingsRef = React.useRef<AppSettings | null>(null)
  /** Chats with an extraction pass in flight, so a fast reply cannot start two. */
  const memoryRunsRef = React.useRef(new Set<string>())

  // Mirrors for the stable callbacks below — they run after paint, so a click
  // handler always reads the state the user is looking at.
  React.useEffect(() => {
    threadsRef.current = threads
    activeIdRef.current = activeId
    sessionsRef.current = sessions
    providersRef.current = providers
    providerIdRef.current = providerId
    modelRef.current = model
    settingsRef.current = settings
  })

  /**
   * Opening chats must not retain every transcript for the lifetime of the
   * WebView. Keep a tiny LRU, while active and streaming threads are protected.
   */
  const cacheThread = React.useCallback(
    (
      current: Record<string, StoredMessage[]>,
      id: string,
      body: StoredMessage[]
    ) => {
      const access = threadAccessRef.current.filter((entry) => entry !== id)
      access.push(id)
      threadAccessRef.current = access

      const next = { ...current, [id]: body }
      let count = Object.keys(next).length
      if (count <= MAX_CACHED_THREADS) return next

      const protectedIds = new Set([
        id,
        activeIdRef.current,
        ...abortsRef.current.keys(),
      ])
      for (const candidate of access) {
        if (count <= MAX_CACHED_THREADS) break
        if (protectedIds.has(candidate) || next[candidate] === undefined) continue
        delete next[candidate]
        count--
      }
      threadAccessRef.current = access.filter((entry) => next[entry] !== undefined)
      return next
    },
    []
  )

  const messages = threads[activeId] ?? EMPTY_MESSAGES
  /**
   * Ask Question answers are replayed to the model as a user turn, but the
   * tool row above already shows them — rendering the raw prompt as well is
   * duplicate noise. Keeps the same array when there is nothing to drop, so
   * the memoized rows never re-render for this.
   */
  const visibleMessages = React.useMemo(
    () =>
      messages.some(isInternalMessage)
        ? messages.filter((message) => !isInternalMessage(message))
        : messages,
    [messages]
  )
  /**
   * The plan bar above the composer. A streaming turn rewrites `messages` every
   * frame while the plan itself changes a handful of times per run, so the scan
   * runs against a deferred copy — React drops the intermediate ones.
   */
  const deferredMessages = React.useDeferredValue(messages)
  const todos = React.useMemo(
    () => latestTodos(deferredMessages),
    [deferredMessages]
  )
  /**
   * The composer's context ring. `base` is recomputed every render but only
   * *changes* when a turn reports its usage, so the memoized composer below is
   * not rebuilt while one is streaming.
   */
  const draftStore = useDraftStore()
  const contextTurn = contextTurnUsage(messages)
  const contextTotal = React.useMemo(
    () => models.find((option) => option.id === model)?.contextLength,
    [model, models]
  )
  const activeSession = sessions.find((session) => session.id === activeId)
  /**
   * What each agent already holds in this chat, for the composer's provider
   * list. Left to the compiler to memoize — a hand-written `useMemo` over a
   * value derived from `sessions` is exactly the shape it refuses to preserve.
   */
  const sessionHints = providerSessionHints(
    activeSession?.agentSessions,
    activeSession?.cwd
  )
  const activeRun = runs[activeId]
  const isGenerating = !!activeRun
  /**
   * The transcript as the list sees it: same objects, except where a turn's
   * file card needs the media it produced folded in (`lib/turn-files`). The
   * live turn is left alone — its card is only rendered once it settles, so
   * rebuilding it per token would be pure waste.
   */
  const listMessages = React.useMemo(() => {
    const live = isGenerating ? visibleMessages.length - 1 : -1
    let patched = false
    const next = visibleMessages.map((message, index) => {
      const withFiles = index === live ? message : withTurnFiles(message)
      if (withFiles !== message) patched = true
      return withFiles
    })
    return patched ? next : visibleMessages
  }, [isGenerating, visibleMessages])
  const threadLoading =
    !!activeId &&
    threads[activeId] === undefined &&
    (activeSession?.messageCount ?? 0) > 0
  const isEmptyChat = messages.length === 0 && !threadLoading
  const drawerOpen = mobileNavOpen && !isDesktop
  // The file panel is a resizable pane on desktop and an overlay below md.
  // Derived, so exactly one FilePreview is ever mounted.
  const dockedPreview = isDesktop ? preview : null
  const overlayPreview = isDesktop ? null : preview
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
        prev[id] !== undefined ? prev : cacheThread(prev, id, loaded)
      )
    } catch (err) {
      toast.error(errorMessage(err, "Could not load this chat"))
    } finally {
      inflightRef.current.delete(id)
    }
  }, [cacheThread])

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

  /**
   * Points the pickers at the agent a chat was last run with. The chat's own
   * provider wins over the settings default; an agent that is gone (or off)
   * falls back to whatever `fallback` resolved to, without rewriting what the
   * chat remembers.
   */
  const adoptAgent = React.useCallback(
    (session: SessionMeta | undefined, list: ProviderInfo[], fallback = "") => {
      const stored = session?.providerId ?? ""
      const usable = list.find((item) => item.id === stored)?.available
        ? stored
        : list.length === 0 && stored
          ? stored
          : fallback
      if (usable) setProviderId(usable)
      if (usable === stored && session?.model) setModel(session.model)
      // Unlike the model, this is cleared when the chat has no pick of its own:
      // the harness's default is derived, and a stale mode must not leak from
      // the chat being left behind into the one being opened.
      setPermissionMode(
        usable === stored ? (session?.permissionMode ?? "") : ""
      )
    },
    []
  )

  /** Writes the picked agent onto the open chat, so reopening it restores it. */
  const persistAgent = React.useCallback(
    (patch: {
      providerId?: string
      model?: string
      permissionMode?: string
    }) => {
      const sessionId = activeIdRef.current
      if (!sessionId) return
      patchLocal(sessionId, patch)
      void api
        .patchSession(sessionId, patch)
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not save the chat's agent"))
        )
    },
    [patchLocal]
  )

  const chooseProvider = React.useCallback(
    (id: string) => {
      setProviderId(id)
      // The model this provider resolves to is persisted once its list lands.
      providerPickRef.current = id
      persistAgent({ providerId: id })
    },
    [persistAgent]
  )

  const configureProvider = React.useCallback(async (id: string) => {
    try {
      const result = await api.configureProviderBinary(id)
      if ("cancelled" in result && result.cancelled) return
      if (!("path" in result)) return
      setProviders(result.providers)
      const next = result.providers.find((provider) => provider.id === id)
      if (next?.available) {
        setProviderId(id)
        providerPickRef.current = id
        persistAgent({ providerId: id })
        toast.success(`${next.name} is ready.`)
        return
      }
      toast.success(`Saved ${result.path}`)
      if (next?.unavailableReason) toast.message(next.unavailableReason)
    } catch (err: unknown) {
      toast.error(errorMessage(err, "Could not configure the harness"))
    }
  }, [persistAgent])

  const chooseModel = React.useCallback(
    (id: string) => {
      setModel(id)
      persistAgent({ model: id })
    },
    [persistAgent]
  )

  const choosePermission = React.useCallback(
    (mode: PermissionMode) => {
      setPermissionMode(mode)
      persistAgent({ permissionMode: mode })
    },
    [persistAgent]
  )

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
      adoptAgent(
        cachedSessions.find((s) => s.id === restored),
        []
      )
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

      let providerList: ProviderInfo[] = []
      let fallbackProvider = ""
      if (providersResult.status === "fulfilled") {
        providerList = providersResult.value
        setProviders(providerList)
        const preferred =
          settingsResult.status === "fulfilled"
            ? settingsResult.value.providers.active
            : ""
        fallbackProvider = pickProvider(providerList, preferred)
        setProviderId(fallbackProvider)
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
        // Last, so the reopened chat's own agent wins over the settings default.
        adoptAgent(
          list.find((session) => session.id === restored),
          providerList,
          fallbackProvider
        )
        if (restored) void loadThread(restored)
      } else {
        toast.error("Could not load your chats")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [adoptAgent, loadThread])

  // Models follow the active provider; the current pick survives when it can.
  const defaultModel = settings?.chat.defaultModel ?? ""
  React.useEffect(() => {
    if (!providerId) return
    let cancelled = false
    api
      .fetchModels(providerId)
      .then((data) => {
        if (cancelled) return
        const groups = data.groups ?? []
        setModels(data.models)
        setModelGroups(groups)
        setCapabilities(data.capabilities ?? null)
        setVisionModels(data.visionModels ?? [])
        // A grouped catalog hands out composite `<source>/<model>` ids. A pick
        // stored before that — on the chat, or as the settings default — names
        // a bare Ollama model, so try its composite form before deciding the
        // model is gone and silently landing on the first of the list.
        const resolve = (id: string) => {
          if (!id) return ""
          if (data.models.some((m) => m.id === id)) return id
          if (groups.length === 0) return ""
          // A slash does not make an id composite: `hf.co/user/model` is a
          // legitimate Ollama tag, and its first segment names no source here.
          // Only a known group id means the id was already composite.
          const slash = id.indexOf("/")
          const source = slash > 0 ? id.slice(0, slash) : ""
          if (source && groups.some((group) => group.id === source)) return ""
          const composite = joinModelId("ollama", id)
          return data.models.some((m) => m.id === composite) ? composite : ""
        }
        const next =
          resolve(modelRef.current) ||
          resolve(defaultModel) ||
          (data.models[0]?.id ?? "")
        setModel(next)
        // Only a provider the user just picked writes back: opening a chat
        // resolves models too, and that must not overwrite its stored agent.
        if (providerPickRef.current === providerId) {
          providerPickRef.current = ""
          if (next) persistAgent({ model: next })
        }
        if (data.error) toast.error(data.error)
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(errorMessage(err, "Could not load models"))
      })
    return () => {
      cancelled = true
    }
  }, [providerId, defaultModel, persistAgent])

  React.useEffect(() => {
    if (!bootstrappedRef.current) return
    writeCache(CACHE_INDEX_KEY, sessions)
  }, [sessions])

  React.useEffect(() => {
    if (activeId) writeCache(CACHE_ACTIVE_KEY, activeId)
  }, [activeId])

  // Same microtask trick as the sidebar seed: read the closed sections after
  // mount without a setState in the effect body.
  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      const cached = readCache<Record<string, boolean>>(CACHE_SECTIONS_KEY)
      if (cached) setClosedSections(cached)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const sectionsDirtyRef = React.useRef(false)
  React.useEffect(() => {
    // The seed itself must not write back — only a real toggle does.
    if (!sectionsDirtyRef.current) return
    writeCache(CACHE_SECTIONS_KEY, closedSections)
  }, [closedSections])

  const toggleSection = React.useCallback((id: string) => {
    sectionsDirtyRef.current = true
    setClosedSections((prev) => {
      const next = { ...prev }
      if (next[id]) delete next[id]
      else next[id] = true
      return next
    })
  }, [])

  const openSection = React.useCallback((id: string) => {
    setClosedSections((prev) => {
      if (!prev[id]) return prev
      sectionsDirtyRef.current = true
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

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

  const selectSession = React.useCallback(
    (id: string) => {
      // Background chats keep streaming — selecting never aborts a run.
      setMobileNavOpen(false)
      const current = activeIdRef.current
      if (current !== id) {
        // The open file belongs to a turn in the chat being left behind.
        setPreview(null)
        // Crossing between the centered opening and a thread slides the composer.
        const from = threadsRef.current[current]?.length ?? 0
        const to = threadsRef.current[id]?.length ?? 0
        if ((from === 0) !== (to === 0)) {
          runLayoutTransition(() => setActiveId(id))
        } else {
          setActiveId(id)
        }
        // Each chat keeps the agent it was last run with.
        adoptAgent(
          sessionsRef.current.find((session) => session.id === id),
          providersRef.current,
          providerIdRef.current
        )
      }
      const cached = threadsRef.current[id]
      if (cached !== undefined) {
        setThreads((prev) => cacheThread(prev, id, cached))
      }
      void loadThread(id)
    },
    [adoptAgent, cacheThread, loadThread]
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
          .createSession({
            providerId,
            model,
            permissionMode: chosenPermission || undefined,
            ...next,
          })
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
    [chosenPermission, model, patchLocal, providerId]
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
    if (activeIdRef.current === id) setPreview(null)
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

  const removeSessions = React.useCallback((ids: string[]) => {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    for (const id of ids) {
      abortsRef.current.get(id)?.abort()
      abortsRef.current.delete(id)
    }
    setThreads((prev) => {
      let changed = false
      const next = { ...prev }
      for (const id of ids) {
        if (next[id] === undefined) continue
        delete next[id]
        changed = true
      }
      return changed ? next : prev
    })
    setRuns((prev) => {
      let next = prev
      for (const id of ids) next = omit(next, id)
      return next
    })
    setFailures((prev) => {
      let next = prev
      for (const id of ids) next = omit(next, id)
      return next
    })
    setSessions((prev) => {
      const next = prev.filter((session) => !idSet.has(session.id))
      setActiveId((current) =>
        idSet.has(current) ? (next[0]?.id ?? "") : current
      )
      return next
    })
    for (const id of ids) {
      void api
        .deleteSession(id)
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not delete the chat"))
        )
    }
    toast.message(
      ids.length === 1 ? "Chat deleted" : `${ids.length} chats deleted`
    )
  }, [])

  const handleNewChat = React.useCallback(async () => {
    setMobileNavOpen(false)
    setPreview(null)
    const empty = sessions.find(
      (session) =>
        session.messageCount === 0 && (threadsRef.current[session.id]?.length ?? 0) === 0
    )
    if (empty) {
      selectSession(empty.id)
      return
    }
    try {
      const created = await api.createSession({
        providerId,
        model,
        permissionMode: chosenPermission || undefined,
      })
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
  }, [
    chosenPermission,
    messages.length,
    model,
    providerId,
    selectSession,
    sessions,
  ])

  /* ---------------------------------------------------------------------- */
  /* Running a turn                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Updates the user memory after a turn settles.
   *
   * Fire-and-forget on purpose: the answer is already delivered and persisted,
   * so this owns nothing the chat needs. It reports itself in two places for
   * two different reasons — a corner toast while it runs, because a
   * local model can take a few seconds and silence would read as a hang, and a
   * marker in the thread afterwards, because "a file that goes into every
   * future conversation just changed" deserves something the user can scroll
   * back to rather than something that fades.
   */
  const runMemoryUpdate = React.useCallback(async (sessionId: string) => {
    const memory = settingsRef.current?.memory
    if (!memory?.enabled || !memory.autoUpdate || !memory.model) return
    if (memoryRunsRef.current.has(sessionId)) return
    memoryRunsRef.current.add(sessionId)

    const toastId = `memory-${sessionId}`
    // No position override: this rides the app's own corner (the `Toaster`'s
    // `bottom-right`), where every other notification in the app appears.
    const at = { id: toastId } as const
    toast.loading("Updating memory\u2026", at)
    try {
      const result = await api.updateMemory(sessionId)
      if (result.changes.length > 0) {
        setMemoryNotices((prev) => ({
          ...prev,
          [sessionId]: {
            changes: result.changes,
            compacted: result.compacted,
          },
        }))
        toast.dismiss(toastId)
      } else if (result.skipped === "unreachable") {
        toast.error("Memory: no Ollama server to extract with.", at)
      } else if (result.skipped === "failed") {
        toast.error("Couldn't update memory.", at)
      } else {
        // Nothing durable was said. That is the common case, and it is not
        // worth a line of UI.
        toast.dismiss(toastId)
      }
    } catch {
      toast.error("Couldn't update memory.", at)
    } finally {
      memoryRunsRef.current.delete(sessionId)
    }
  }, [])

  const dismissMemoryNotice = React.useCallback((sessionId: string) => {
    setMemoryNotices((prev) => omit(prev, sessionId))
  }, [])

  const runPrompt = React.useCallback(
    async (args: {
      sessionId: string
      prompt: string
      prior: StoredMessage[]
      providerId: string
      model: string
      effort?: string
      permissionMode?: PermissionMode
      attachments?: MessageAttachmentData[]
      animate?: boolean
      titleFrom?: string
      /** The app wrote this prompt, not the user — keep it out of the list. */
      internal?: boolean
    }) => {
      const { sessionId, prompt, prior } = args
      const startedAt = nowMs()
      const assistantId = newId()
      const userMessage: StoredMessage = {
        id: newId(),
        content: prompt,
        sender: "user",
        createdAt: startedAt,
        ...(args.internal ? { internal: true } : null),
        ...(args.attachments?.length ? { attachments: args.attachments } : null),
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
        // Last turn's marker belongs to last turn.
        setMemoryNotices((prev) =>
          sessionId in prev ? omit(prev, sessionId) : prev
        )
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
          const lastIndex = current.length - 1
          if (current[lastIndex]?.id === assistantId) {
            return {
              ...prev,
              [sessionId]: [
                ...current.slice(0, lastIndex),
                updater(current[lastIndex]),
              ],
            }
          }
          const index = current.findIndex((message) => message.id === assistantId)
          if (index < 0) return prev
          const next = [...current]
          next[index] = updater(next[index])
          return {
            ...prev,
            [sessionId]: next,
          }
        })
      }

      const setStage = (stage: GenerationStage) => {
        setRuns((prev) => {
          const run = prev[sessionId]
          if (!run || run.startedAt !== startedAt) return prev
          // Real output supersedes whatever the backend last said it was up
          // to, so the stage change clears the status line with it.
          if (run.stage === stage && run.status === undefined) return prev
          return { ...prev, [sessionId]: { startedAt: run.startedAt, stage } }
        })
      }

      const setStatus = (status: string, stage: GenerationStage) => {
        setRuns((prev) => {
          const run = prev[sessionId]
          if (!run || run.startedAt !== startedAt) return prev
          if (run.stage === stage && run.status === status) return prev
          return { ...prev, [sessionId]: { ...run, stage, status } }
        })
      }

      let failed = false
      let needsAttention = false
      const markFailed = () => {
        failed = true
        setFailures((prev) => ({ ...prev, [sessionId]: true }))
      }

      const notifiedAskTools = new Set<string>()

      /**
       * Say why the turn stopped, in the turn itself. A message that already
       * has parts renders those and never its flat `content`, so a run that
       * died after some reasoning or a tool call used to leave a truncated
       * bubble and nothing but a toast that fades.
       */
      const failAssistant = (reason: string) => {
        failed = true
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
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined
      const cancelFlush = () => {
        if (frame && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(frame)
        }
        frame = 0
        if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
        fallbackTimer = undefined
      }
      const flush = () => {
        cancelFlush()
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
        const last = queued.at(-1)
        if (
          (event.type === "text" || event.type === "thinking") &&
          last?.type === event.type
        ) {
          queued[queued.length - 1] = { ...last, text: last.text + event.text }
        } else if (
          event.type === "tool" &&
          last?.type === "tool" &&
          last.id === event.id
        ) {
          queued[queued.length - 1] = event
        } else {
          queued.push(event)
        }
        if (frame || fallbackTimer !== undefined) return
        frame =
          typeof requestAnimationFrame === "function"
            ? requestAnimationFrame(flush)
            : 0
        // Background WebViews can pause rAF indefinitely. The fallback keeps
        // queued stream events bounded even while the window is hidden.
        fallbackTimer = setTimeout(flush, document.hidden ? 50 : 100)
      }
      /** Run-level events must not overtake the text they follow. */
      const drain = () => {
        cancelFlush()
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
            // Mirrors what the chat route persists, so the details popover
            // says the same thing before and after a reload.
            metadata: {
              model: args.model,
              providerId: args.providerId,
              responseTime: elapsed,
              finishedAt: nowMs(),
              ...folderMetadata(sessionsRef.current, sessionId),
              ...(event.usage?.input == null
                ? null
                : { inputTokens: event.usage.input }),
              ...(event.usage?.output == null
                ? null
                : { outputTokens: event.usage.output }),
              ...(event.usage?.tokensPerSecond == null
                ? null
                : { tokensPerSecond: event.usage.tokensPerSecond }),
              ...(event.usage?.input == null && event.usage?.output == null
                ? null
                : {
                    tokens:
                      (event.usage?.input ?? 0) + (event.usage?.output ?? 0),
                  }),
            },
          }))
          if (event.sessionId) {
            patchLocal(sessionId, { providerSessionId: event.sessionId })
          }
          if (
            (settings?.chat.notificationSounds ?? true) &&
            !failed &&
            !needsAttention
          ) {
            playAgentNotificationSound("completion")
          }
          return
        }
        if (event.type === "status") {
          // Progress, not content: nothing to fold into the message.
          setStatus(event.text, statusStage(event.stage))
          return
        }
        if (event.type === "thinking") setStage("thinking")
        else if (event.type === "text") setStage("responding")
        else if (event.type === "tool") {
          setStage("searching")
          if (isOpenAskTool(event)) {
            needsAttention = true
            if (
              (settings?.chat.notificationSounds ?? true) &&
              !notifiedAskTools.has(event.id)
            ) {
              notifiedAskTools.add(event.id)
              playAgentNotificationSound("question")
            }
          }
        }
        enqueue(event)
      }

      /**
       * The app's own end-of-turn frame: which agents now hold a session in
       * this chat, and the handoff this turn was actually sent. Folding the
       * marker into the message here is what makes it survive a reload
       * unchanged — the chat route persisted the identical object.
       */
      const onTurnState = (state: TurnStateFrame) => {
        if (state.agentSessions) {
          patchLocal(sessionId, { agentSessions: state.agentSessions })
        }
        if (!state.handoff) return
        patchAssistant((message) =>
          message.id === state.messageId
            ? {
                ...message,
                metadata: { ...message.metadata, handoff: state.handoff },
              }
            : message
        )
      }

      try {
        await api.streamChat(
          {
            prompt,
            providerId: args.providerId,
            model: args.model,
            sessionId,
            effort: args.effort,
            permissionMode: args.permissionMode,
            userMessageId: userMessage.id,
            assistantMessageId: assistantId,
            attachments: args.attachments,
          },
          { onEvent, onTurnState, signal: controller.signal }
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
        /* Only a turn that actually landed is worth learning from. A stopped
           one is usually about to be re-sent, and a failed one would spend a
           model call to stack a second toast under the failure's own. */
        if (!controller.signal.aborted && !failed) void runMemoryUpdate(sessionId)
      }
    },
    [patchLocal, runMemoryUpdate, settings?.chat.notificationSounds]
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

      // Only images can travel as real attachments, and only to a provider
      // and model that can actually look at them — everything else falls
      // back to the original behavior: a plain name mentioned in the text.
      const visionEligible = !!capabilities?.vision && visionModels.includes(model)
      const imageFiles = files.filter(isImageFile)
      const otherFiles = files.filter((file) => !isImageFile(file))
      const oversizedImages = imageFiles.filter(
        (file) => file.size > MAX_IMAGE_BYTES
      )
      const sizedImages = imageFiles.filter(
        (file) => file.size <= MAX_IMAGE_BYTES
      )

      if (oversizedImages.length > 0) {
        const limitMb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024))
        toast.error(
          oversizedImages.length === 1
            ? `"${oversizedImages[0].name}" is over ${limitMb}MB — attaching the name only`
            : `${oversizedImages.length} images are over ${limitMb}MB — attaching the names only`
        )
      }

      let attachments: MessageAttachmentData[] = []
      let namedOnly = [...otherFiles, ...oversizedImages]

      if (sizedImages.length > 0) {
        if (visionEligible) {
          try {
            attachments = await Promise.all(
              sizedImages.map(async (file) => ({
                id: newId(),
                name: file.name,
                mimeType: file.type || "image/*",
                url: await readFileAsDataUrl(file),
              }))
            )
          } catch (err) {
            toast.error(errorMessage(err, "Could not read an attached image"))
            namedOnly = [...namedOnly, ...sizedImages]
          }
        } else {
          const activeName =
            providers.find((item) => item.id === providerId)?.name ?? providerId
          toast.message(
            `${activeName || "This provider"} can't see images — attaching the name only`
          )
          namedOnly = [...namedOnly, ...sizedImages]
        }
      }

      const fileNote =
        namedOnly.length > 0
          ? `\n\nAttached: ${namedOnly.map((file) => file.name).join(", ")}`
          : ""
      const content = `${skillPrefix}${text}${fileNote}`

      if (!sessionId) {
        try {
          const created = await api.createSession({
            providerId,
            model,
            permissionMode: chosenPermission || undefined,
          })
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
        permissionMode: chosenPermission || undefined,
        attachments,
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
      capabilities?.vision,
      chosenPermission,
      effort,
      model,
      patchLocal,
      providerId,
      providers,
      runPrompt,
      sessions,
      settings?.chat.autoTitle,
      visionModels,
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
            ? ASK_ANSWER_SKIPPED
            : `${ASK_ANSWER_PREFIX}${JSON.stringify(result.answers)}`,
          prior: next,
          providerId,
          model,
          effort: capabilities?.effort ? effort : undefined,
          permissionMode: chosenPermission || undefined,
          internal: true,
        })
      })()
    },
    [
      activeId,
      capabilities?.effort,
      commitThread,
      chosenPermission,
      effort,
      model,
      providerId,
      runPrompt,
    ]
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
          permissionMode: chosenPermission || undefined,
        })
      })()
    },
    [
      activeId,
      capabilities?.effort,
      commitThread,
      chosenPermission,
      effort,
      model,
      providerId,
      runPrompt,
    ]
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
  /* File preview                                                            */
  /* ---------------------------------------------------------------------- */

  const closePreview = React.useCallback(() => setPreview(null), [])

  /**
   * The saved split rides in on the panes' own `defaultSize` rather than the
   * group's `defaultLayout`: the group mounts before the file pane exists, and
   * a layout naming a panel that is not there yet is ignored.
   */
  React.useEffect(() => {
    const saved = readPreviewSize()
    // Deferred — a synchronous setState in an effect body is a lint error here.
    if (saved != null) queueMicrotask(() => setPreviewSize(saved))
  }, [])

  const saveSplit = React.useCallback((layout: Layout) => {
    const size = layout[PREVIEW_PANEL_ID]
    if (size == null) return
    writeCache(CACHE_SPLIT_KEY, size)
  }, [])

  /**
   * Opens the panel from what the transcript already holds, then fills in the
   * file's text from disk when that arrives. The fetch is strictly an
   * enrichment: it never gates the open, and a failure (no such file, another
   * machine's workspace, a path outside it) leaves the diff-only view standing.
   *
   * Disk text is only merged when the transcript carried none — a tool that
   * streamed its own after-file already matches the diff beside it, and a
   * partial read carries a `startLine` the whole file would not line up with.
   */
  const openPreview = React.useCallback((file: FilePreviewFile) => {
    const session = sessionsRef.current.find(
      (item) => item.id === activeIdRef.current
    )
    // An image has no text to read: the panel takes a URL on the app's own
    // origin instead, and `/api/files` streams the bytes.
    const opened: FilePreviewFile = isImagePath(file.path)
      ? {
          ...file,
          imageSrc:
            file.imageSrc ?? localFileUrlFrom(file.path, session?.cwd),
        }
      : file
    setPreview(opened)
    if (opened.imageSrc || opened.content !== undefined) return
    const provider = session?.providerId || providerIdRef.current
    if (!provider) return
    void api
      .fetchFile(file.path, provider, session?.id ?? "")
      .then((data) => {
        setPreview((current) =>
          current && current.path === file.path && current.content === undefined
            ? { ...current, content: data.content }
            : current
        )
      })
      .catch(() => {
        /* the panel degrades to the diff on its own */
      })
  }, [])

  /**
   * A path a tool named → a URL this page can load it from. Images only: the
   * tool row and the panel show the picture, and `/api/files` serves the bytes
   * on the app's own origin because a browser will not fetch `file://` from an
   * http page. Stable, so the memoized rows keep their render while a turn
   * streams.
   */
  const resolveFileUrl = React.useCallback((path: string) => {
    if (!isImagePath(path)) return undefined
    const session = sessionsRef.current.find(
      (item) => item.id === activeIdRef.current
    )
    return localFileUrlFrom(path, session?.cwd)
  }, [])

  /**
   * A change row or an inline `path.ts` chip names a path, not a tool — so
   * reach back into the turn for the last tool that touched it. Null when the
   * transcript no longer carries a body for that file.
   */
  const previewFromTurn = React.useCallback(
    (messageId: string, path: string) => {
      const thread = threadsRef.current[activeIdRef.current] ?? EMPTY_MESSAGES
      const message = thread.find((item) => item.id === messageId)
      const tools = message?.tools?.length
        ? message.tools
        : toolsFromParts(message?.parts ?? [])
      let match: FilePreviewFile | null = null
      for (const tool of tools) {
        const file = filePreviewFromTool(tool)
        if (file?.path === path) match = file
      }
      return match
    },
    []
  )

  const handleOpenFile = React.useCallback(
    (_messageId: string, tool: MessageToolCallData) => {
      const file = filePreviewFromTool(tool)
      if (!file) {
        toast.message("That tool call has no file to preview")
        return
      }
      openPreview(file)
    },
    [openPreview]
  )

  const handleChangeFileClick = React.useCallback(
    (messageId: string, change: ChangeSummaryFile) => {
      openPreview(
        previewFromTurn(messageId, change.path) ?? {
          path: change.path,
          added: change.additions,
          removed: change.deletions,
        }
      )
    },
    [openPreview, previewFromTurn]
  )

  /**
   * The badge hands over the path with any `:line` suffix already dropped;
   * stripped again here because a host, not the component, decides what a
   * location means.
   */
  const handleFileReferenceClick = React.useCallback(
    (messageId: string, reference: string) => {
      const path = reference.replace(/:\d+(?::\d+)?$/, "")
      openPreview(previewFromTurn(messageId, path) ?? { path })
    },
    [openPreview, previewFromTurn]
  )

  const handleReviewChanges = React.useCallback(
    (messageId: string) => {
      const thread = threadsRef.current[activeIdRef.current] ?? EMPTY_MESSAGES
      const message = thread.find((item) => item.id === messageId)
      const tools = message?.tools?.length
        ? message.tools
        : toolsFromParts(message?.parts ?? [])
      const first = tools.map(filePreviewFromTool).find(Boolean)
      if (first) openPreview(first)
      else toast.message("This turn changed no files")
    },
    [openPreview]
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
          ? (run.status ??
            STAGE_SUBTITLES[run.stage === "idle" ? "thinking" : run.stage])
          : // The folder is the section header now, so the row is free to say
            // what answered in it.
            session.messageCount === 0
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

  /** Pinned chats, then one section per working folder. */
  const { pinned: pinnedItems, folders: folderGroups } = React.useMemo(
    () => groupSessions(sessions, sessionItems),
    [sessionItems, sessions]
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
      const session = sessionsRef.current.find((item) => item.id === id)
      // The rename input has to be on screen: open the section holding it.
      if (session) openSection(groupIdForSession(session))
      setRenameRequest((prev) => ({ id, token: prev.token + 1 }))
    },
    [isDesktop, openSection]
  )

  const showEfforts =
    !!capabilities?.effort && (settings?.chat.defaultEffort ?? "") !== ""

  const activeProviderName = providers.find(
    (item) => item.id === providerId
  )?.name

  /**
   * Group headings carry the source's brand mark. Built once per catalog, not
   * per render: the composer memo below would otherwise be rebuilt every frame
   * of a streaming turn.
   */
  const pickerGroups = React.useMemo<ModelPickerGroup[]>(
    () =>
      modelGroups.map((group) => ({
        ...group,
        icon: <ProviderLogo slug={group.id} className="size-3.5" />,
      })),
    [modelGroups]
  )

  /**
   * The composer holds the draft the user is typing and has nothing to do with
   * the answer streaming above it, so it is kept off the per-frame render path.
   */
  const composer = React.useMemo(
    () => (
      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        onTextChange={draftStore.set}
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
              onChange={chooseProvider}
              sessions={sessionHints}
              onConfigure={configureProvider}
            />
            <ModelPicker
              value={model}
              onChange={chooseModel}
              options={models}
              /* One section is just the flat list with a heading over it. */
              groups={pickerGroups.length > 1 ? pickerGroups : undefined}
              efforts={showEfforts ? DEFAULT_MODEL_EFFORTS : false}
              effort={effort}
              onEffortChange={setEffort}
              side="top"
              className="min-w-0"
            />
            {permissionModes.length > 0 && effectivePermission ? (
              <PermissionPicker
                modes={permissionModes}
                value={effectivePermission}
                onChange={choosePermission}
              />
            ) : null}
            <ContextUsage
              store={draftStore}
              input={contextTurn.input}
              output={contextTurn.output}
              total={contextTotal}
            />
          </>
        }
      />
    ),
    [
      activeProviderName,
      chooseModel,
      choosePermission,
      chooseProvider,
      configureProvider,
      contextTotal,
      contextTurn.input,
      contextTurn.output,
      draftStore,
      effectivePermission,
      effort,
      handleSend,
      handleStop,
      isEmptyChat,
      isGenerating,
      model,
      models,
      pendingAsk,
      permissionModes,
      pickerGroups,
      providerId,
      providers,
      sessionHints,
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
            // Only the pinned list reorders by hand: a folder section is
            // ordered by activity, and `order` is one global sequence with
            // nothing per-folder to write back to. `from`/`to` are indices
            // inside their own list, so the ids are what map onto `sessions`.
            if (drop.listId !== PINNED_GROUP_ID) return
            if (drop.fromListId !== drop.listId) return
            const list = sessionsRef.current
            const from = list.findIndex((item) => item.id === drop.itemId)
            const to = list.findIndex((item) => item.id === drop.overId)
            if (from < 0 || to < 0 || from === to) return
            setSessions((prev) => arrayMove(prev, from, to))
            void api
              .patchSession(drop.itemId, { order: to })
              .catch((err: unknown) =>
                toast.error(errorMessage(err, "Could not reorder chats"))
              )
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
          footer={
            (isDesktop ? collapsed : false) ? (
              <>
                <SideIconBtn
                  label="Settings"
                  onClick={() => router.push("/settings")}
                >
                  <SettingsIcon className="size-4" />
                </SideIconBtn>
                <ThemeToggle floating={false} className={SIDEBAR_THEME_TOGGLE} />
              </>
            ) : (
              <div className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  <SideRow
                    icon={<SettingsIcon className="size-4" />}
                    onClick={() => router.push("/settings")}
                  >
                    Settings
                  </SideRow>
                </div>
                <ThemeToggle floating={false} className={SIDEBAR_THEME_TOGGLE} />
              </div>
            )
          }
        >
          {sessionItems.length === 0 ? (
            <SidebarCollapsibleSection title="Chats" open onToggle={noop}>
              {!sessionsLoaded ? (
                <SidebarLoading />
              ) : (
                <SidebarEmptyState>New chats appear here.</SidebarEmptyState>
              )}
            </SidebarCollapsibleSection>
          ) : null}

          {pinnedItems.length > 0 ? (
            <SidebarSessionSection
              id={PINNED_GROUP_ID}
              title="Pinned"
              sortable
              open={!closedSections[PINNED_GROUP_ID]}
              onToggle={toggleSection}
              sessions={pinnedItems}
              activeId={activeId}
              renameRequest={renameRequest}
              onSelect={selectSession}
              onRename={renameSession}
              onTogglePin={togglePin}
              onDelete={removeSession}
              onDeleteMany={removeSessions}
            />
          ) : null}

          {folderGroups.map((group) => (
            <SidebarFolderSection
              key={group.id}
              group={group}
              open={!closedSections[group.id]}
              onToggle={toggleSection}
              activeId={activeId}
              renameRequest={renameRequest}
              onSelect={selectSession}
              onRename={renameSession}
              onTogglePin={togglePin}
              onDelete={removeSession}
              onDeleteMany={removeSessions}
            />
          ))}
        </ChatSidebar>
      </ChatSidebarDnd>
    ),
    [
      activeId,
      closedSections,
      collapsed,
      folderGroups,
      handleNewChat,
      isDesktop,
      closeDrawer,
      pinnedItems,
      removeSession,
      removeSessions,
      renameRequest,
      renameSession,
      selectSession,
      sessionItems,
      sessionsLoaded,
      toggleSection,
      togglePin,
      router,
    ]
  )

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-background">
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
          <AppHeaderActions>
            <AppHeaderButton
              label="Search chats and commands"
              hint="⌘K"
              onClick={() => setPaletteOpen(true)}
            >
              <Search />
            </AppHeaderButton>
          </AppHeaderActions>
        </AppHeader>

{/*
          Everything below the header — the header itself spans the full width
          right of the sidebar, because it doubles as the desktop window's drag
          chrome and must never be covered or squeezed by the file panel. The
          `relative` here is what the below-md overlay anchors to.
        */}
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {/*
            Desktop: the conversation and the file panel are two panes of one
            draggable split. A pane's content wrapper carries an inline
            `overflow: auto`, so the children that own their own scrolling turn
            it off through `style` — a class would lose to the inline rule.
          */}
          <ResizablePanelGroup
            id={WORKSPACE_GROUP_ID}
            orientation="horizontal"
            onLayoutChanged={saveSplit}
            className="min-w-0 flex-1"
          >
            <ResizablePanel
              id={CHAT_PANEL_ID}
              defaultSize={`${100 - previewSize}%`}
              minSize="40%"
              className="flex min-w-0 flex-col"
              style={{ overflow: "hidden" }}
            >
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
                    messages={listMessages}
                    isGenerating={isGenerating}
                    generationStage={activeRun?.stage ?? "idle"}
                    generationLabel={activeRun?.status}
                    onEditMessage={handleEditMessage}
                    onAskAnswer={handleAskAnswer}
                    onOpenFile={handleOpenFile}
                    onChangeFileClick={handleChangeFileClick}
                    onFileReferenceClick={handleFileReferenceClick}
                    onReviewChanges={handleReviewChanges}
                    resolveFileUrl={resolveFileUrl}
                    renderActions={(message) =>
                      message.sender === "assistant" ? (
                        <>
                          {/* Attached to the turn it explains, through the
                              list's own render slot — the vendored component
                              knows nothing about handoffs. */}
                          {(message as StoredMessage).metadata?.handoff ? (
                            <HandoffNotice
                              handoff={
                                (message as StoredMessage).metadata!.handoff!
                              }
                            />
                          ) : null}
                          <MessageActions
                            message={message as StoredMessage}
                            providerName={providerName(
                              (message as StoredMessage).metadata?.providerId ??
                                ""
                            )}
                            onRegenerate={handleRegenerate}
                            onDelete={handleDeleteMessage}
                          />
                        </>
                      ) : null
                    }
                  >
                    {/* Composed in through the list's own `children` slot: the
                        marker belongs after the last turn, inside the
                        conversation column, and `MessageList` stays
                        untouched. */}
                    {memoryNotices[activeId] && !isGenerating ? (
                      <MemoryNotice
                        changes={memoryNotices[activeId].changes}
                        compacted={memoryNotices[activeId].compacted}
                        onDismiss={() => dismissMemoryNotice(activeId)}
                      />
                    ) : null}
                  </MessageList>
                )}

                <div data-slot="chat-composer" className="w-full shrink-0">
                  {isEmptyChat ? (
                    /* Aligned with the composer card's own measure, so the two
                       read as one control rather than two stacked ones. */
                    <div className="mx-auto flex w-full max-w-3xl px-3 pb-2 sm:px-4">
                      <FolderPicker
                        variant="inline"
                        cwd={activeSession?.cwd}
                        gitBranch={activeSession?.gitBranch}
                        onChange={setFolder}
                      />
                    </div>
                  ) : null}
                  {/* The plan the turn is working through, collapsed to one
                      line. Keyed by chat so switching threads never carries a
                      disclosure — or a plan — across. */}
                  <TodoPanel key={activeId} items={todos} />
                  {composer}
                  {isEmptyChat && (settings?.chat.showSuggestions ?? true) ? (
                    <PromptSuggestions
                      items={SUGGESTIONS}
                      onSelect={(item) => void send(item.label, [], [])}
                    />
                  ) : null}
                </div>
              </div>
            </ResizablePanel>

            {dockedPreview ? (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel
                  id={PREVIEW_PANEL_ID}
                  defaultSize={`${previewSize}%`}
                  minSize={`${MIN_PREVIEW_SIZE}%`}
                  maxSize={`${MAX_PREVIEW_SIZE}%`}
                  className="flex min-w-0 flex-col"
                  style={{ overflow: "hidden" }}
                >
                  <FilePreview
                    file={dockedPreview}
                    onClose={closePreview}
                    className="border-l"
                  />
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>

          {/*
            Below md the file panel slides over the conversation, like the
            sidebar — but inside this wrapper, so it stops at the header.
          */}
          <div
            aria-hidden={!preview}
            onClick={closePreview}
            className={cn(
              "absolute inset-0 z-40 bg-foreground/20 backdrop-blur-[1px] transition-opacity duration-200 motion-reduce:transition-none md:hidden",
              preview ? "opacity-100" : "pointer-events-none opacity-0"
            )}
          />
          <div
            data-slot="chat-file-panel"
            // Off-canvas when closed: keep it out of the tab order either way.
            inert={!preview}
            className={cn(
              "absolute inset-y-0 right-0 z-50 w-[min(30rem,100%)] overflow-hidden bg-background shadow-xl",
              "transition-transform duration-300 ease-in-out motion-reduce:transition-none md:hidden",
              !preview && "translate-x-full"
            )}
          >
            {overlayPreview ? (
              <FilePreview
                file={overlayPreview}
                onClose={closePreview}
                className="border-l"
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

type SidebarSectionProps = {
  open: boolean
  /** Takes the section id, so the row of sections shares one stable callback. */
  onToggle: (id: string) => void
  activeId: string
  renameRequest: { id: string; token: number }
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
  onDelete: (id: string) => void
  onDeleteMany: (ids: string[]) => void
}

const SidebarSessionSection = React.memo(function SidebarSessionSection({
  id,
  title,
  action,
  sortable = false,
  open,
  onToggle,
  sessions,
  ...rest
}: SidebarSectionProps & {
  id: string
  title: React.ReactNode
  /** Rendered at the right edge of the header, before the count. */
  action?: React.ReactNode
  /** Hand-made order — only the pinned group has one to keep. */
  sortable?: boolean
  sessions: ChatSidebarItemData[]
}) {
  const toggle = React.useCallback(() => onToggle(id), [id, onToggle])
  return (
    <SidebarCollapsibleSection
      title={title}
      open={open}
      onToggle={toggle}
      action={action}
      count={sessions.length}
    >
      <ChatSidebarItemList
        items={sessions}
        activeId={rest.activeId}
        listId={id}
        renameRequest={rest.renameRequest}
        sortable={sortable}
        draggable
        onSelect={rest.onSelect}
        onRename={rest.onRename}
        onTogglePin={rest.onTogglePin}
        onDelete={rest.onDelete}
        onDeleteMany={rest.onDeleteMany}
      />
    </SidebarCollapsibleSection>
  )
})

/**
 * One working folder's chats. The header carries what the rows used to repeat —
 * the folder and its branch — and keeps a live dot while the section is closed,
 * so a turn running inside it is never hidden by the fold.
 */
const SidebarFolderSection = React.memo(function SidebarFolderSection({
  group,
  open,
  ...rest
}: SidebarSectionProps & { group: SessionGroup }) {
  return (
    <SidebarSessionSection
      {...rest}
      id={group.id}
      open={open}
      title={<span title={group.cwd || undefined}>{group.label}</span>}
      action={
        <span className="flex min-w-0 items-center gap-1.5 normal-case">
          {group.branch ? (
            <SidebarItemBadge branch={group.branch} className="min-w-0" />
          ) : null}
          {group.running && !open ? (
            <SidebarItemStatusDot status="streaming" />
          ) : null}
        </span>
      }
      sessions={group.items}
    />
  )
})

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function pickProvider(list: ProviderInfo[], preferred: string) {
  const wanted = list.find((item) => item.id === preferred)
  if (wanted?.available) return wanted.id
  return list.find((item) => item.available)?.id ?? preferred ?? ""
}

/**
 * The folder the run actually used, for the details popover. Read from the
 * sidebar mirror rather than passed down, so a turn that started before the
 * folder was set still records the one the route ran in.
 */
function folderMetadata(sessions: SessionMeta[], sessionId: string) {
  const session = sessions.find((item) => item.id === sessionId)
  if (!session?.cwd) return null
  return {
    cwd: session.cwd,
    ...(session.gitBranch ? { gitBranch: session.gitBranch } : null),
  }
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
 * A turn the app wrote for the model, not one the user typed. The flag is
 * authoritative; the prefix match covers threads stored before it existed,
 * and is narrow enough that a real prompt cannot trip it.
 */
function isInternalMessage(message: StoredMessage) {
  if (message.internal) return true
  return (
    message.sender === "user" &&
    (message.content === ASK_ANSWER_SKIPPED ||
      message.content.startsWith(`${ASK_ANSWER_PREFIX}{`))
  )
}

/**
 * Only the latest turn can still be waiting on an answer — matching the row
 * `MessageList` offers a form for. An unanswered ask further back is history,
 * and picking it up here would rewrite a stored transcript the user closed
 * long ago.
 */
/**
 * A turn's file card, cached against the stored message so it is built once
 * per turn rather than once per render. `turnFiles` answers undefined when it
 * has nothing to add, and the message object is then handed on untouched —
 * which is what keeps the memoized row from re-rendering.
 */
const turnFilesCache = new WeakMap<StoredMessage, StoredMessage>()

function withTurnFiles(message: StoredMessage): StoredMessage {
  const cached = turnFilesCache.get(message)
  if (cached) return cached
  const changes = message.changes ?? turnFiles(message)
  const next = changes === message.changes ? message : { ...message, changes }
  turnFilesCache.set(message, next)
  return next
}

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
