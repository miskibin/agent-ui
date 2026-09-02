/**
 * Stand-in for `@/components/ui/message-parts` under `node --test` — see the
 * note in `change-summary.ts`. Copied verbatim from the vendored file.
 */

export type MessageToolCallData = {
  id: string
  name: string
  status?: "pending" | "running" | "done" | "error"
  input?: string
  output?: string
  exitCode?: number
}

export function parseToolArgs(input?: string): Record<string, unknown> {
  if (!input?.trim()) return {}
  try {
    const value = JSON.parse(input) as unknown
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    /* raw string */
  }
  return {}
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg",
])

export function isImagePath(path?: string) {
  if (!path) return false
  const base = path.split(/[\\/]/).pop() ?? path
  const ext = base.includes(".") ? base.split(".").pop()?.toLowerCase() : undefined
  return !!ext && IMAGE_EXTENSIONS.has(ext)
}
