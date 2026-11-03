import { NextResponse } from "next/server"

import { MAX_ASSET_BYTES, saveAsset } from "@/lib/notes/server"
import { crossOriginRefusal } from "@/lib/request-origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Stores an image pasted or dropped into a note; answers the `src` to write. */
export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  let file: File | null = null
  try {
    const form = await req.formData()
    const value = form.get("file")
    file = value instanceof File ? value : null
  } catch {
    /* fall through */
  }
  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 })
  if (file.size > MAX_ASSET_BYTES) return NextResponse.json({ error: "The image is too large." }, { status: 413 })
  try {
    const src = await saveAsset(new Uint8Array(await file.arrayBuffer()), file.name, file.type)
    return NextResponse.json({ src })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
