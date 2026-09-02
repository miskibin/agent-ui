"use client"

import * as React from "react"
import { type Layout } from "react-resizable-panels"
import { toast } from "sonner"

import type { FileActionItem } from "@/components/ui/change-summary"
import {
  filePreviewFromTool,
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
  const { activeIdRef, providerIdRef, sessionsRef, threadsRef } = refs

  /** The file open in the right-hand panel; null = the panel is closed. */
  const [preview, setPreview] = React.useState<FilePreviewFile | null>(null)
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
   * machine's workspace, a path outside it) leaves the diff-only view standing.
   *
   * Disk text is only merged when the transcript carried none — a tool that
   * streamed its own after-file already matches the diff beside it, and a
   * partial read carries a `startLine` the whole file would not line up with.
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
      if (opened.imageSrc || opened.content !== undefined) return
      const provider = session?.providerId || providerIdRef.current
      if (!provider) return
      void api
        .fetchFile(file.path, provider, session?.id ?? "")
        .then((data) => {
          setPreview((current) =>
            current &&
            current.path === file.path &&
            current.content === undefined
              ? {
                  ...current,
                  // The route answers with the path it actually read: an
                  // answer that only said `Messages.tsx` gets the real one
                  // back, and the header, the menu and "Copy path" all name
                  // that file.
                  path: data.path || current.path,
                  content: data.content,
                }
              : current
          )
        })
        .catch(() => {
          /* the panel degrades to the diff on its own */
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
          setPreview((latest) =>
            latest && latest.path === path
              ? { ...latest, content: data.content }
              : latest
          )
        })
        .catch(() => {
          /* the panel keeps the diff */
        })
    },
    [activeId, revertProvider]
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
  const handleFileReferenceClick = React.useCallback(
    (messageId: string, reference: string, line?: number) => {
      const path = reference.replace(/:\d+(?::\d+)?$/, "")
      const file = previewFromTurn(messageId, path) ?? { path }
      openPreview(line ? { ...file, focusLine: line } : file)
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
    fileActions,
    resolveFileUrl,
    handleOpenFile,
    handleChangeFileClick,
    handleFileReferenceClick,
    handleChatChangeClick,
    handleReviewChanges,
  }
}
