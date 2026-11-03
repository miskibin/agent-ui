import { assetType, readAsset } from "@/lib/notes/server"
import { crossOriginRefusal } from "@/lib/request-origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ name: string }> }

/**
 * An image stored in the vault. Served like `/api/files`: same-site only,
 * `nosniff`, and sandboxed, because an SVG is a document that can carry script.
 */
export async function GET(req: Request, ctx: Ctx) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  const { name } = await ctx.params
  const bytes = await readAsset(name)
  if (!bytes) return new Response("Not found", { status: 404 })
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": assetType(name),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  })
}
