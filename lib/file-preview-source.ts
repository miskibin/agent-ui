/**
 * Where the file panel's body comes from — the transcript, or the disk.
 *
 * The panel opens instantly from what the turn already carries, and that is
 * the whole reason this decision is not obvious: a tool call sometimes carries
 * the file, and sometimes carries only a *look* at it. Getting the two mixed
 * up is what makes a 3000-line file render as its first forty lines and claim
 * to be the file.
 *
 * Three bodies can reach the panel, and only the middle one is the file:
 *
 * - **A window.** A read tool's output. `offset` and `limit` are the point of
 *   that tool, so the text is a slice by design — and the harnesses cap tool
 *   output at 50k characters on top of that (`MAX_FIELD`, every provider),
 *   which silently shortens even a read that asked for everything. `startLine`
 *   is the field that marks a body as a window: it exists precisely because
 *   the text does not start at line 1.
 * - **An after-file.** The whole text a mutation tool wrote. It is the state
 *   that turn produced, which is what the diff beside it describes, so it must
 *   *not* be replaced by what is on disk now — the file has moved on since,
 *   and a diff that no longer matches its own body is worse than a stale one.
 * - **Nothing at all.** A change-card row, a `path.ts:42` chip, the whole-chat
 *   file list. The disk is the only source there is.
 *
 * So the rule is: a window is a placeholder to paint while the real read
 * lands, an after-file stands, and everything else is read. Kept here, pure
 * and free of React, because it is the part worth testing.
 */

/** The subset of the vendored `FilePreviewFile` this decision reads. */
export type PreviewBody = {
  content?: string
  startLine?: number
  focusLine?: number
  imageSrc?: string
}

/** What `GET /api/file` answers with, as far as the merge is concerned. */
export type DiskRead = {
  path?: string
  content: string
  truncated?: boolean
  bytes?: number
}

/**
 * The panel showed a head, not the file: `GET /api/file` stops at its own cap.
 * Carried beside the preview rather than on it — the vendored `FilePreviewFile`
 * is the component's shape, and this is the app saying something *about* the
 * body, not part of it.
 */
export type PreviewNotice = { truncated: true; bytes?: number }

/** A body that is a window on the file rather than the file. */
export function isPartialBody(file: PreviewBody): boolean {
  return file.content !== undefined && file.startLine !== undefined
}

/**
 * Does the panel still have to go to disk?
 *
 * An image has no text body — `/api/files` streams the picture instead. A
 * whole after-file stands. A window, or nothing, is read.
 */
export function needsDiskRead(file: PreviewBody): boolean {
  if (file.imageSrc) return false
  return file.content === undefined || isPartialBody(file)
}

/**
 * Disk text over whatever the transcript seeded.
 *
 * `startLine` does not survive the merge: the body is the whole file now, and
 * a start line left behind would renumber every row of it. Where the agent was
 * reading becomes the panel's focus instead, so a `Read` at offset 500 opens
 * on line 500 of the real file rather than on a headless snippet — but never
 * over a focus the caller asked for, which is a `file.ts:42` chip and outranks
 * a guess.
 *
 * Returns the preview unchanged when the read does not belong to it, so a
 * response that lands after the reader has moved on cannot rewrite the file
 * they are looking at.
 */
export function mergeDiskRead<T extends PreviewBody & { path: string }>(
  current: T,
  requestedPath: string,
  data: DiskRead
): T {
  if (current.path !== requestedPath) return current
  const focusLine =
    current.focusLine ??
    (current.startLine !== undefined && current.startLine > 1
      ? current.startLine
      : undefined)
  const merged: T = {
    ...current,
    // The route answers with the path it actually read: an answer that only
    // said `Messages.tsx` gets the real one back, and the header, the menu and
    // "Copy path" all name that file.
    path: data.path || current.path,
    content: data.content,
  }
  delete merged.startLine
  if (focusLine === undefined) delete merged.focusLine
  else merged.focusLine = focusLine
  return merged
}

/** The banner the panel owes the reader when only a head was served. */
export function noticeFromDiskRead(data: DiskRead): PreviewNotice | null {
  return data.truncated ? { truncated: true, bytes: data.bytes } : null
}
