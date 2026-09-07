"use client"

import { FileWarning } from "lucide-react"

import { BinaryFilePanel } from "@/components/binary-file"
import type { FileActionItem } from "@/components/ui/change-summary"
import {
  FilePreview,
  type FilePreviewDiffLayout,
  type FilePreviewFile,
  type DiffLineCommentRange,
} from "@/components/ui/file-preview"
import type { PreviewNotice } from "@/lib/file-preview-source"
import { cn } from "@/lib/utils"

/** `1.5 MB`, `912 kB` — a size a reader can weigh, not a digit count. */
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} kB`
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`
}

/**
 * The file panel's three bodies behind one mount: the file, a binary file's
 * stand-in, and the one thing the panel owes a reader that neither of those
 * can say — that what they are looking at is a *head*, not the file.
 *
 * `GET /api/file` stops at its own cap, and a body that silently ends early
 * looks exactly like a file that ends there. So the banner is not decoration:
 * it is the difference between "this file is 900 lines" and "we showed you the
 * first 900 lines of it". It names the real size for the same reason — a limit
 * without a magnitude tells the reader nothing about how much is missing.
 *
 * It lives here rather than inside `FilePreview` because that component is
 * vendored from chat-components and renders text or a diff; a claim about how
 * the host read the file is the host's to make. Both mount points in
 * `app/page.tsx` — the docked pane and the drawer below `md` — render this, so
 * the two can never disagree about what the panel shows.
 */
export function FilePanel({
  file,
  binary,
  notice,
  actions,
  onCopyPath,
  onClose,
  onLineComment,
  diffLayout,
  onDiffLayoutChange,
  wrap,
  onWrapChange,
  className,
}: {
  file: FilePreviewFile
  /** The route answered "that file is binary"; there is no text to render. */
  binary: boolean
  /** Set when the route served only the file's head. */
  notice: PreviewNotice | null
  actions?: FileActionItem[]
  onCopyPath?: (path: string) => void
  onClose?: () => void
  onLineComment?: (range: DiffLineCommentRange) => void
  diffLayout: FilePreviewDiffLayout
  onDiffLayoutChange: (layout: FilePreviewDiffLayout) => void
  wrap: boolean
  onWrapChange: (wrap: boolean) => void
  className?: string
}) {
  // Not text, and the route said so: the name and the same actions menu rather
  // than a diff about bytes nobody can read.
  if (binary) {
    return (
      <BinaryFilePanel
        path={file.path}
        actions={actions}
        onCopyPath={onCopyPath}
        onClose={onClose}
        className={className}
      />
    )
  }

  const preview = (
    <FilePreview
      file={file}
      onClose={onClose}
      actions={actions}
      onCopyPath={onCopyPath}
      {...(onLineComment ? { onLineComment } : null)}
      diffLayout={diffLayout}
      onDiffLayoutChange={onDiffLayoutChange}
      wrap={wrap}
      onWrapChange={onWrapChange}
      // With a banner below it the panel is a flex item, not the whole pane:
      // `flex-1` sets a flex-basis of 0, which is what stops its own `h-full`
      // from claiming the row the banner needs. The border stays on the
      // wrapper, so it is drawn once.
      className={notice ? "min-h-0 flex-1" : className}
    />
  )

  if (!notice) return preview

  return (
    <div
      data-slot="file-panel"
      className={cn("flex h-full min-h-0 w-full flex-col overflow-hidden", className)}
    >
      {preview}
      <div
        data-slot="file-panel-truncated"
        role="status"
        className="flex shrink-0 items-center gap-1.5 border-t bg-muted px-3 py-1.5 text-[11.5px] text-muted-foreground"
      >
        <FileWarning aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0">
          Showing the start of this file
          {notice.bytes ? ` — it is ${formatBytes(notice.bytes)}` : null}. Open it
          in your editor to see the rest.
        </span>
      </div>
    </div>
  )
}
