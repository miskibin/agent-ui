import {
  fileChangesFromTools,
  type ChangeSummaryFile,
} from "@/components/ui/change-summary"
import {
  isImagePath,
  parseToolArgs,
  type MessageToolCallData,
} from "@/components/ui/message-parts"
import { localFilesInMarkdown } from "@/lib/local-media"
import { toolsFromParts } from "@/lib/message-stream"
import type { StoredMessage } from "@/lib/store/types"

/**
 * The turn's file card.
 *
 * `fileChangesFromTools` sees what the agent edited through a tool, which
 * misses the files a run *produces*: a chart written by the script it just
 * ran, a screenshot a command took. Nothing edited them, so the only trace
 * they leave is elsewhere in the turn — the agent opens the picture, the
 * answer embeds it, or the answer simply names it (`wykres.png`). All three
 * are folded in here, after the edits and without stats, since nothing was
 * diffed.
 *
 * Returns undefined when there is nothing to add, which leaves the card to the
 * component's own derivation (and keeps the message object identical, so the
 * memoized row does not re-render).
 */
export function turnFiles(message: StoredMessage): ChangeSummaryFile[] | undefined {
  if (message.sender !== "assistant") return undefined
  const tools = message.tools?.length
    ? message.tools
    : toolsFromParts(message.parts ?? [])

  const changes = fileChangesFromTools(tools)
  const seen = new Set(changes.map((file) => fileKey(file.path)))
  const extra: ChangeSummaryFile[] = []
  const add = (path: string) => {
    const key = fileKey(path)
    // A turn names the same file both ways — `wykres.png` in the answer,
    // `D:\work\wykres.png` in the tool that read it. One row, not two.
    if (!key || [...seen].some((known) => sameFile(known, key))) return
    seen.add(key)
    extra.push({ path })
  }

  for (const path of mediaFromTools(tools)) add(path)
  for (const text of answerText(message)) {
    for (const path of embeddedMedia(text)) add(path)
    for (const path of namedMedia(text)) add(path)
  }

  return extra.length > 0 ? [...changes, ...extra] : undefined
}

/** Images a tool touched — the agent viewing what it just rendered. */
function mediaFromTools(tools: MessageToolCallData[]) {
  const paths: string[] = []
  for (const tool of tools) {
    if (tool.status && tool.status !== "done") continue
    const args = parseToolArgs(tool.input)
    const path =
      asString(args.path) ??
      asString(args.filePath) ??
      asString(args.target_file) ??
      asString(args.file)
    if (path && isImagePath(path)) paths.push(path)
  }
  return paths
}

/** Everything the turn said, minus its fenced code — see `namedMedia`. */
function answerText(message: StoredMessage) {
  const texts = [message.content]
  for (const part of message.parts ?? []) {
    if (part.type === "text") texts.push(part.text)
  }
  return texts.filter(Boolean).map((text) => text.replace(FENCED_CODE, ""))
}

/** Images the answer shows — already rewritten to the files route. */
function embeddedMedia(text: string) {
  return localFilesInMarkdown(text)
}

/**
 * Files the answer merely *names* — the `wykres.png` chip under a chart it
 * just rendered. Narrowed to artifact file types on purpose: an answer names
 * source files all the time (`app/page.tsx`), and those are not this turn's
 * output unless a tool actually touched them.
 */
function namedMedia(text: string) {
  const paths: string[] = []
  for (const match of text.matchAll(INLINE_CODE)) {
    const value = match[1].trim()
    if (!value || /\s/.test(value)) continue
    if (isArtifactPath(value)) paths.push(value)
  }
  return paths
}

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g
const INLINE_CODE = /`([^`\n]+)`/g

/** Output file types — a picture, a document, a data drop, a recording. */
const ARTIFACT_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "svg",
  "pdf",
  "csv",
  "tsv",
  "xlsx",
  "zip",
  "mp4",
  "webm",
  "mp3",
  "wav",
])

function isArtifactPath(path: string) {
  const base = path.split(/[\\/]/).pop() ?? path
  const ext = base.includes(".") ? base.split(".").pop()?.toLowerCase() : undefined
  return !!ext && ARTIFACT_EXTENSIONS.has(ext)
}

/** Case- and separator-insensitive, so Windows paths compare sanely. */
function fileKey(path: string) {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

/** Same file named two ways: one path is the other's tail. */
function sameFile(a: string, b: string) {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}
