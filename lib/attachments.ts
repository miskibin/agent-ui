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

/**
 * Past this a text attachment is pasted into the prompt as a fenced block.
 * Small on purpose: the whole file lands in the model's context, and in the
 * user bubble.
 */
export const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024 // 256 KB

const TEXT_EXTENSION_RE =
  /\.(txt|md|mdx|markdown|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|csv|tsv|log|xml|svg|html?|css|s[ac]ss|less|[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|swift|c|h|cc|cpp|cxx|hpp|cs|php|sh|bash|zsh|fish|ps1|bat|sql|graphql|gql|proto|prisma|vue|svelte|astro|lua|r|jl|scala|clj|ex|exs|erl|hs|ml|nim|zig|dart|tf|hcl|dockerfile|gitignore|editorconfig|lock)$/i

/** A file whose bytes are worth reading into the prompt as text. */
export function isTextFile(file: File) {
  if (file.type.startsWith("text/")) return true
  if (/^application\/(json|xml|yaml|x-yaml|toml|javascript|typescript|x-sh)$/.test(file.type)) {
    return true
  }
  return TEXT_EXTENSION_RE.test(file.name) || /^(dockerfile|makefile|readme)$/i.test(file.name)
}

/** Reads a text attachment; rejects on a read error. */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () =>
      reject(reader.error ?? new Error(`Could not read ${file.name}`))
    reader.readAsText(file)
  })
}

/** The fence a text attachment travels in, named so the model knows the file. */
export function fenceTextAttachment(name: string, content: string) {
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : ""
  // A fence long enough that the file's own backticks cannot close it.
  const longest = content.match(/`{3,}/g)?.reduce((a, b) => (b.length > a.length ? b : a), "") ?? ""
  const fence = "`".repeat(Math.max(3, longest.length + 1))
  return `\n\nAttached file: ${name}\n${fence}${ext}\n${content.replace(/\n$/, "")}\n${fence}`
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
