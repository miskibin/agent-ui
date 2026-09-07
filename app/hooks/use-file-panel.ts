"use client"

import * as React from "react"
import { type Layout } from "react-resizable-panels"
import { toast } from "sonner"

import { refreshFolderStatus } from "@/components/folder-status"
import {
  addLineComment,
  clearLineComments,
  setLineCommentComposer,
} from "@/components/line-comments"
import type { FileActionItem } from "@/components/ui/change-summary"
import {
  filePreviewFromTool,
  type DiffLineCommentRange,
  type FilePreviewDiffLayout,
  type FilePreviewFile,
} from "@/components/ui/file-preview"
import type {
  ChangeSummaryFile,
  MessageToolCallData,
} from "@/components/ui/message"
import { isImagePath } from "@/components/ui/message-parts"
import * as api from "@/lib/api-client"
import { buildFileActions } from "@/lib/file-actions"
import {
  mergeDiskRead,
  needsDiskRead,
  noticeFromDiskRead,
  type PreviewNotice,
} from "@/lib/file-preview-source"
import { localFileUrlFrom, resolveLocalPath } from "@/lib/local-media"
import { toolsFromParts } from "@/lib/message-stream"
import {
  CACHE_PREVIEW_PREFS_KEY,
  CACHE_SPLIT_KEY,
  readCache,
  writeCache,
} from "@/lib/ui-cache"

import { EMPTY_FILE_ACTIONS, EMPTY_MESSAGES } from "./chat-types"
import type { ChatRefs } from "./use-chat-refs"

/** The conversation and the file panel are the two panes of one split. */
export const WORKSPACE_GROUP_ID = "chat-workspace"
export const CHAT_PANEL_ID = "chat"
export const PREVIEW_PANEL_ID = "preview"
export const DEFAULT_PREVIEW_SIZE = 35
export const MIN_PREVIEW_SIZE = 20
export const MAX_PREVIEW_SIZE = 60

export type PreviewPrefs = { layout: FilePreviewDiffLayout; wrap: boolean }
const DEFAULT_PREVIEW_PREFS: PreviewPrefs = { layout: "unified", wrap: true }

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

export type FilePanel = ReturnType<typeof useFilePanel>

/**
 * The file panel beside the conversation: which file is open, how wide the
 * split is, how the diff is drawn — and every way a file gets opened, from a
 * tool row, a change card, an inline `path.ts:42` chip or the whole-chat
 * change list.
 *
 * Every handler here reads the open chat through the refs rather than closing
 * over it, because they are handed to the memoized message rows.
 */
export function useFilePanel({
  refs,
  activeId,
  activeCwd,
  revertProvider,
  defaultEditor,
}: {
  refs: ChatRefs
  activeId: string
  activeCwd: string | undefined
  /** The harness whose workspace a re-read resolves against. */
  revertProvider: string
  defaultEditor: string
}) {
  const { activeIdRef, composerRef, providerIdRef, sessionsRef, threadsRef } =
    refs

  /** The file open in the right-hand panel; null = the panel is closed. */
  const [preview, setPreview] = React.useState<FilePreviewFile | null>(null)
  /**
   * The open file turned out not to be text. Kept beside `preview` rather than
   * on it: `FilePreviewFile` is the vendored shape, and this is the app saying
   * what to render instead of the panel, not a field the component reads.
   */
  const [previewBinary, setPreviewBinary] = React.useState(false)
  /**
   * The panel is showing a head, not the file: `GET /api/file` stops at its
   * own cap. Beside `preview` for the same reason `previewBinary` is — this is
   * the app saying something *about* the body, not a field the vendored
   * component reads.
   */
  const [previewNotice, setPreviewNotice] = React.useState<PreviewNotice | null>(
    null
  )
  /**
   * Which open the panel is on. A read that lands after the reader has moved
   * on belongs to the file they left, so it is dropped rather than applied to
   * the one they are looking at.
   */
  const openNonceRef = React.useRef(0)
  // Where the divider was last dragged to. Read after mount, not during
  // render: the pane it sizes is not on screen yet, and localStorage does not
  // exist while the page prerenders.
  const [previewSize, setPreviewSize] = React.useState(DEFAULT_PREVIEW_SIZE)
  const [previewPrefs, setPreviewPrefs] =
    React.useState<PreviewPrefs>(DEFAULT_PREVIEW_PREFS)
  /** What "open in editor" can reach on this machine; asked for once. */
  const [openTargets, setOpenTargets] = React.useState<api.OpenTargets | null>(
    null
  )

  // What this machine can open a file in. Once: installed apps do not change
  // mid-session, and the answer only decorates a menu.
  React.useEffect(() => {
    let cancelled = false
    api
      .fetchOpenTargets()
      .then((targets) => {
        if (!cancelled) setOpenTargets(targets)
      })
      .catch(() => {
        /* the menu falls back to a generic "Open in editor" */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The panel preferences, read back after mount — same microtask deferral as
  // the sidebar seed.
  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      const prefs = readCache<Partial<PreviewPrefs>>(CACHE_PREVIEW_PREFS_KEY)
      if (prefs) {
        setPreviewPrefs({
          layout: prefs.layout === "split" ? "split" : "unified",
          wrap: prefs.wrap !== false,
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const closePreview = React.useCallback(() => {
    setPreview(null)
    setPreviewBinary(false)
    setPreviewNotice(null)
  }, [])

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

  const setDiffLayout = React.useCallback((layout: FilePreviewDiffLayout) => {
    setPreviewPrefs((prev) => {
      const next = { ...prev, layout }
      writeCache(CACHE_PREVIEW_PREFS_KEY, next)
      return next
    })
  }, [])

  const setWrap = React.useCallback((wrap: boolean) => {
    setPreviewPrefs((prev) => {
      const next = { ...prev, wrap }
      writeCache(CACHE_PREVIEW_PREFS_KEY, next)
      return next
    })
  }, [])

  /** The panel's path is whatever the tool said; the clipboard gets it absolute. */
  const handleCopyPath = React.useCallback(
    (path: string) => {
      const session = sessionsRef.current.find(
        (item) => item.id === activeIdRef.current
      )
      void navigator.clipboard
        ?.writeText(resolveLocalPath(path, session?.cwd))
        .then(() => toast.success("Path copied"))
        .catch(() => toast.error("Could not write to the clipboard"))
    },
    [activeIdRef, sessionsRef]
  )

  /**
   * Opens the panel from what the transcript already holds, then fills in the
   * file's text from disk when that arrives. The fetch is strictly an
   * enrichment: it never gates the open, and a failure (no such file, another
   * machine's workspace, a path outside it) leaves whatever the turn carried
   * standing.
   *
   * Which bodies survive that read is the whole subtlety, and it lives in
   * `lib/file-preview-source`: a read tool's output is a *window* on a file —
   * `offset` and `limit` are the point of that tool, and every harness caps
   * tool output at 50k characters besides — so it is a placeholder to paint
   * while the real read lands, never the file. A mutation tool's after-file is
   * the state that turn produced and stands, because the diff beside it
   * describes exactly that.
   */
  const openPreview = React.useCallback(
    (file: FilePreviewFile) => {
      const session = sessionsRef.current.find(
        (item) => item.id === activeIdRef.current
      )
      // An image has no text to read: the panel takes a URL on the app's own
      // origin instead, and `/api/files` streams the bytes.
      const opened: FilePreviewFile = isImagePath(file.path)
        ? {
            ...file,
            imageSrc: file.imageSrc ?? localFileUrlFrom(file.path, session?.cwd),
          }
        : file
      setPreview(opened)
      setPreviewBinary(false)
      setPreviewNotice(null)
      const nonce = ++openNonceRef.current
      if (!needsDiskRead(opened)) return
      const provider = session?.providerId || providerIdRef.current
      if (!provider) return
      void api
        .fetchFile(file.path, provider, session?.id ?? "")
        .then((data) => {
          // A read that landed after the reader moved on belongs to the file
          // they left. Checked once, for both outcomes: `path` alone cannot
          // tell a re-open of the same file from the open it replaced.
          if (openNonceRef.current !== nonce) return
          // Not text: the panel says so, with the same actions menu, instead
          // of falling back to a diff that describes bytes nobody can read.
          if (data.binary) {
            setPreview((current) =>
              current && current.path === file.path
                ? { ...current, path: data.path || current.path }
                : current
            )
            setPreviewBinary(true)
            return
          }
          setPreview((current) =>
            current ? mergeDiskRead(current, file.path, data) : current
          )
          setPreviewNotice(noticeFromDiskRead(data))
        })
        .catch(() => {
          /* the panel degrades to what the turn carried on its own */
        })
    },
    [activeIdRef, providerIdRef, sessionsRef]
  )

  /**
   * After `git checkout -- <file>`, the open panel is showing the state the
   * revert just discarded. Re-read it so the File view says what is on disk.
   */
  const handleReverted = React.useCallback(
    (path: string) => {
      if (!activeId || !revertProvider) return
      void api
        .fetchFile(path, revertProvider, activeId)
        .then((data) => {
          // A binary file has no text to put back; the panel is already
          // showing the "not text" state and should keep it.
          if (data.binary) return
          setPreview((latest) =>
            latest ? mergeDiskRead(latest, path, data) : latest
          )
          setPreviewNotice(noticeFromDiskRead(data))
        })
        .catch(() => {
          /* the panel keeps the diff */
        })
    },
    [activeId, revertProvider]
  )

  /**
   * What the panel is showing, readable without closing over it. Written in an
   * effect rather than during render, the way the rest of the chat's mirrors
   * are: `restoreTurn` below has to know which file to re-read, and it must
   * not be rebuilt every time the panel opens a different one.
   */
  const previewRef = React.useRef<FilePreviewFile | null>(null)
  React.useEffect(() => {
    previewRef.current = preview
  }, [preview])

  /**
   * Undo an entire turn on disk: the chat's folder goes back to the worktree
   * checkpoint taken before that turn ran (`lib/checkpoints`), and the open
   * file is re-read afterwards so the panel stops showing a version that no
   * longer exists.
   *
   * This deletes work — files the agent created since are removed — so it is
   * deliberately *not* confirmed here. The caller asks first, through the same
   * toast action "Revert changes" uses, and calls this from it.
   */
  const restoreTurn = React.useCallback(
    async (turn: number) => {
      if (!activeId) return false
      try {
        const response = await fetch("/api/checkpoints/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: activeId, turn }),
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string
          } | null
          toast.error(body?.error ?? "Could not restore that checkpoint")
          return false
        }
      } catch {
        toast.error("Could not restore that checkpoint")
        return false
      }
      toast.success("Restored the folder to before that turn")
      const open = previewRef.current
      if (open) handleReverted(open.path)
      // The worktree just moved under everything that describes it: the
      // sidebar's folder badge and the changed-files tree both read
      // `/api/git/status`, whose server-side cache the route already dropped.
      const cwd = sessionsRef.current
        .find((item) => item.id === activeId)
        ?.cwd?.trim()
      if (cwd) refreshFolderStatus(cwd)
      return true
    },
    [activeId, handleReverted, sessionsRef]
  )

  /**
   * "Restore files to before this turn", as the message action offers it.
   *
   * Restoring deletes work — a file the agent created since is removed — so it
   * gets the same second click every other destructive action in this app
   * gets: a toast with the verb on it, in the corner where the outcome will
   * land, rather than a modal in the middle of the conversation.
   */
  const confirmRestoreTurn = React.useCallback(
    (turn: number) => {
      toast.warning("Restore the folder to before this turn?", {
        description:
          "Files the agent changed or created after that point go back to how they were. This cannot be undone.",
        duration: 8_000,
        action: {
          label: "Restore",
          onClick: () => void restoreTurn(turn),
        },
      })
    },
    [restoreTurn]
  )

  /**
   * The right-click menu on every file in the chat. Rebuilt only when the
   * chat, its folder, the detected editors or the editor setting change —
   * the rows it reaches are memoized on the array's identity.
   */
  const fileActions = React.useMemo<FileActionItem[]>(
    () =>
      activeId
        ? buildFileActions({
            sessionId: activeId,
            cwd: activeCwd,
            platform: openTargets?.platform ?? "",
            editors: openTargets?.editors ?? [],
            defaultEditor,
            onReverted: handleReverted,
          })
        : EMPTY_FILE_ACTIONS,
    [
      activeCwd,
      activeId,
      defaultEditor,
      handleReverted,
      openTargets?.editors,
      openTargets?.platform,
    ]
  )

  /**
   * A path a tool named → a URL this page can load it from. Images only: the
   * tool row and the panel show the picture, and `/api/files` serves the bytes
   * on the app's own origin because a browser will not fetch `file://` from an
   * http page. Stable, so the memoized rows keep their render while a turn
   * streams.
   */
  const resolveFileUrl = React.useCallback(
    (path: string) => {
      if (!isImagePath(path)) return undefined
      const session = sessionsRef.current.find(
        (item) => item.id === activeIdRef.current
      )
      return localFileUrlFrom(path, session?.cwd)
    },
    [activeIdRef, sessionsRef]
  )

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
    [activeIdRef, threadsRef]
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
   * The badge hands over the path with any `:line` suffix already dropped and
   * the line beside it; stripped again here because a host, not the
   * component, decides what a location means. The line becomes the panel's
   * focus, so `app/page.tsx:120` opens on line 120.
   */
  const focusNonceRef = React.useRef(0)
  const handleFileReferenceClick = React.useCallback(
    (messageId: string, reference: string, line?: number) => {
      const path = reference.replace(/:\d+(?::\d+)?$/, "")
      const file = previewFromTurn(messageId, path) ?? { path }
      // A second click on the same chip is a fresh request to look at that
      // line; the nonce is what tells the panel so after it has scrolled away.
      openPreview(
        line
          ? { ...file, focusLine: line, focusNonce: ++focusNonceRef.current }
          : file
      )
    },
    [openPreview, previewFromTurn]
  )

  /** A row of the whole-chat change list: the last tool that touched the path. */
  const handleChatChangeClick = React.useCallback(
    (change: ChangeSummaryFile) => {
      const thread = threadsRef.current[activeIdRef.current] ?? EMPTY_MESSAGES
      let match: FilePreviewFile | null = null
      for (const message of thread) {
        const tools = message.tools?.length
          ? message.tools
          : toolsFromParts(message.parts ?? [])
        for (const tool of tools) {
          const file = filePreviewFromTool(tool)
          if (file?.path === change.path) match = file
        }
      }
      openPreview(
        match ?? {
          path: change.path,
          added: change.additions,
          removed: change.deletions,
        }
      )
    },
    [activeIdRef, openPreview, threadsRef]
  )

  /**
   * Lines picked in the panel, on their way to the composer.
   *
   * The pending list is not state of this hook — it has to be readable from
   * the chips bar above the prompt, which is not in this hook's tree — so it
   * lives in the small store `components/line-comments.tsx` owns, and this is
   * where its lifetime is decided: the composer it writes into is registered
   * here, because this is the layer that already holds the chat's refs, and a
   * chat switch drops whatever was never sent.
   */
  React.useEffect(() => {
    setLineCommentComposer(composerRef)
    return () => setLineCommentComposer(null)
  }, [composerRef])

  React.useEffect(() => {
    // A comment is about a file in *this* chat, and it names lines by number:
    // carrying it into the next chat would point at whatever happened to be on
    // those lines there.
    clearLineComments()
  }, [activeId])

  /** Handed to `FilePreview`; the panel calls it when a range is commented on. */
  const handleLineComment = React.useCallback(
    (range: DiffLineCommentRange) => {
      addLineComment(range)
    },
    []
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
    [activeIdRef, openPreview, threadsRef]
  )

  return {
    preview,
    previewSize,
    previewPrefs,
    closePreview,
    saveSplit,
    setDiffLayout,
    setWrap,
    handleCopyPath,
    openPreview,
    previewBinary,
    previewNotice,
    restoreTurn,
    confirmRestoreTurn,
    fileActions,
    resolveFileUrl,
    handleOpenFile,
    handleChangeFileClick,
    handleFileReferenceClick,
    handleChatChangeClick,
    handleReviewChanges,
    handleLineComment,
  }
}
