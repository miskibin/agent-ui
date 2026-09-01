import type { MessageAttachmentData } from "@/components/ui/message"

/**
 * Image-attachment helpers shared by the composer (`app/page.tsx`) and the
 * chat route (`app/api/chat/route.ts`). Kept dependency-free so both the
 * browser and the Node route can import it.
 */

/**
 * Per-image cap — keeps a giant screenshot from blowing past a serverless
 * request-body limit (base64 already adds ~33%, so a 4MB image is a ~5.5MB
 * request body) or a vision model's context window.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // 4 MB

export function isImageFile(file: File) {
  return file.type.startsWith("image/")
}

/** Reads a File as a `data:<mime>;base64,<data>` URL. */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () =>
      reject(reader.error ?? new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

/** Strips the `data:<mime>;base64,` prefix — Ollama's `/api/chat` wants raw base64. */
export function base64FromDataUrl(dataUrl: string) {
  const comma = dataUrl.indexOf(",")
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}

/** Rough decoded-byte size of a base64 payload — good enough for a sanity cap. */
export function estimateBase64Bytes(base64: string) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/**
 * Validates attachments coming off the wire: well-shaped, an image, a
 * `data:` URL, and under the size cap. Anything else is dropped rather than
 * failing the whole turn — the client already filtered on the way in, this
 * is defense in depth against a stale UI or a hand-rolled request.
 */
export function sanitizeAttachments(input: unknown): MessageAttachmentData[] {
  if (!Array.isArray(input)) return []
  const out: MessageAttachmentData[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const { id, name, mimeType, url } = item as Record<string, unknown>
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      typeof mimeType !== "string" ||
      typeof url !== "string"
    ) {
      continue
    }
    if (!mimeType.startsWith("image/") || !url.startsWith("data:")) continue
    if (estimateBase64Bytes(base64FromDataUrl(url)) > MAX_IMAGE_BYTES) continue
    out.push({ id, name, mimeType, url })
  }
  return out
}
