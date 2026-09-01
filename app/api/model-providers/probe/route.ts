import { NextResponse } from "next/server"

import { listSourceModels, type ModelSource } from "@/lib/model-providers/server"
import { readSettings } from "@/lib/settings/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `POST /api/model-providers/probe` — tests one configured source's
 * `/models` without persisting anything, so the settings row can offer a
 * "Test" button. Always 200: an unreachable endpoint, a rejected key, or an
 * unconfigured slug all come back as `{ ok: false, error }` rather than a
 * failed fetch the client has to special-case.
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" })
  }

  const slug =
    typeof (body as { slug?: unknown } | null)?.slug === "string"
      ? ((body as { slug: string }).slug.trim())
      : ""
  if (!slug) return NextResponse.json({ ok: false, error: "Missing slug" })

  const settings = await readSettings()
  const entry = settings.modelProviders[slug]
  if (!entry) return NextResponse.json({ ok: false, error: "Unknown provider" })
  if (!entry.baseUrl) {
    return NextResponse.json({ ok: false, error: "No base URL configured" })
  }

  const source: ModelSource = {
    slug,
    name: entry.name || slug,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    models: entry.models,
  }

  try {
    const models = await listSourceModels(source)
    return NextResponse.json({ ok: true, count: models.length })
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Failed to reach provider",
    })
  }
}
