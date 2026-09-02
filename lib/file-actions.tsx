"use client"

import {
  Copy,
  ExternalLink,
  FolderOpen,
  SquareTerminal,
  Undo2,
} from "lucide-react"
import { toast } from "sonner"

import type { FileActionItem } from "@/components/ui/change-summary"
import * as api from "@/lib/api-client"
import { isLocalPath, localPathFromUrl, resolveLocalPath } from "@/lib/local-media"

/**
 * What a right-click on a file offers, anywhere in a chat: the change card,
 * the file panel, a path chip, an image. The vendored components only show
 * the menu; this is where "open" and "reveal" turn into something this
 * machine can do, through `/api/open`.
 *
 * Built once per chat and set of detected editors, so the memoized rows that
 * receive the array keep their identity across a streaming turn.
 */

export type FileActionsContext = {
  sessionId: string
  cwd?: string
  platform: string
  editors: api.OpenTarget[]
  /** Id from settings; "" = the first detected editor. */
  defaultEditor: string
  /** Where "Revert changes" reports; omitted = no such entry. */
  onReverted?: (path: string) => void
}

/** How many "Open in <editor>" rows before the rest is left to the default. */
const MAX_EDITOR_ROWS = 4

function revealLabel(platform: string) {
  if (platform === "darwin") return "Reveal in Finder"
  if (platform === "win32") return "Reveal in File Explorer"
  return "Show in file manager"
}

function fileName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path
}

function copyText(text: string, message: string) {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast.success(message))
    .catch(() => toast.error("Could not write to the clipboard"))
}

function fail(err: unknown, fallback: string) {
  toast.error(err instanceof Error && err.message ? err.message : fallback)
}

export function buildFileActions(ctx: FileActionsContext): FileActionItem[] {
  const absolute = (path: string) =>
    resolveLocalPath(localPathFromUrl(path), ctx.cwd)
  const open = (path: string, editor?: string) =>
    api
      .openPath({
        action: "editor",
        path: absolute(path),
        editor,
        sessionId: ctx.sessionId,
      })
      .catch((err: unknown) => fail(err, "Could not open the file"))

  const actions: FileActionItem[] = []

  // The default editor first, named; the other detected ones after it.
  const preferred =
    ctx.editors.find((editor) => editor.id === ctx.defaultEditor) ??
    ctx.editors[0]
  if (preferred) {
    actions.push({
      id: `open:${preferred.id}`,
      label: `Open in ${preferred.name}`,
      icon: <ExternalLink />,
      onSelect: (path) => void open(path, preferred.id),
    })
    for (const editor of ctx.editors
      .filter((entry) => entry.id !== preferred.id)
      .slice(0, MAX_EDITOR_ROWS - 1)) {
      actions.push({
        id: `open:${editor.id}`,
        label: `Open in ${editor.name}`,
        icon: <ExternalLink className="opacity-0" />,
        onSelect: (path) => void open(path, editor.id),
      })
    }
  } else {
    actions.push({
      id: "open",
      label: "Open in editor",
      icon: <ExternalLink />,
      onSelect: (path) => void open(path),
    })
  }

  actions.push({
    id: "reveal",
    label: revealLabel(ctx.platform),
    icon: <FolderOpen />,
    onSelect: (path) =>
      void api
        .openPath({ action: "reveal", path: absolute(path), sessionId: ctx.sessionId })
        .catch((err: unknown) => fail(err, "Could not reveal the file")),
  })
  actions.push({
    id: "terminal",
    label: "Open in terminal",
    icon: <SquareTerminal />,
    onSelect: (path) =>
      void api
        .openPath({ action: "terminal", path: absolute(path), sessionId: ctx.sessionId })
        .catch((err: unknown) => fail(err, "Could not open a terminal")),
  })

  actions.push({
    id: "copy-path",
    label: "Copy path",
    icon: <Copy />,
    separatorBefore: true,
    onSelect: (path) => copyText(absolute(path), "Path copied"),
  })
  actions.push({
    id: "copy-relative",
    label: "Copy relative path",
    icon: <Copy className="opacity-0" />,
    onSelect: (path) => {
      const raw = localPathFromUrl(path)
      const root = ctx.cwd?.replace(/[\\/]+$/, "")
      // Windows paths compare without case: `c:\\Repo` and `C:\\repo` are one folder.
      const windows = !!root && (root.includes("\\") || /^[A-Za-z]:/.test(root))
      const inside =
        !!root &&
        isLocalPath(raw) &&
        (windows
          ? raw.toLowerCase().startsWith(root.toLowerCase())
          : raw.startsWith(root))
      const relative = inside
        ? raw.slice(root.length).replace(/^[\\/]+/, "")
        : raw
      copyText(relative, "Relative path copied")
    },
  })

  if (ctx.onReverted && ctx.cwd) {
    const { onReverted, sessionId } = ctx
    actions.push({
      id: "revert",
      label: "Revert changes…",
      icon: <Undo2 />,
      destructive: true,
      separatorBefore: true,
      onSelect: (path) => {
        const target = localPathFromUrl(path)
        // A destructive action gets a second click, in the corner where every
        // other outcome lands, rather than a modal in the middle of the chat.
        toast.warning(`Discard your changes to ${fileName(target)}?`, {
          description: "Restores the file to what git has — this cannot be undone.",
          duration: 8_000,
          action: {
            label: "Revert",
            onClick: () =>
              void api
                .revertFile(sessionId, absolute(target))
                .then((result) => {
                  toast.success(`Reverted ${result.path}`)
                  onReverted(target)
                })
                .catch((err: unknown) => fail(err, "Could not revert the file")),
          },
        })
      },
    })
  }

  return actions
}
