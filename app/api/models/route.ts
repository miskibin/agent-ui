import { NextResponse } from "next/server"

import { getProvider, resolveActiveProviderId } from "@/lib/providers/registry"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `GET /api/models?provider=<id>` — the models of one provider plus its
 * capabilities, so the composer can wire the effort selector in the same
 * round trip. Listing failures degrade to an empty list with a message
 * rather than a hard error: the picker stays usable.
 */
export async function GET(req: Request) {
  const requested = new URL(req.url).searchParams.get("provider")?.trim()
  const providerId = requested || (await resolveActiveProviderId())
  const provider = await getProvider(providerId)

  if (!provider) {
    return NextResponse.json(
      { providerId, models: [], error: `Unknown or disabled provider "${providerId}"` },
      { status: 404 }
    )
  }

  const info = await provider.info()
  if (!info.available) {
    return NextResponse.json({
      providerId,
      models: [],
      capabilities: info.capabilities,
      error: info.unavailableReason ?? "Provider unavailable",
    })
  }

  try {
    const models = await provider.listModels()
    // Best-effort: a vision probe failing (older server, flaky network)
    // degrades to "no model known to take images" rather than a 500.
    const visionModels = provider.visionModels
      ? await provider.visionModels().catch(() => [])
      : undefined
    // Sections for the picker, when the provider serves more than one source.
    const groups = provider.listModelGroups
      ? await provider.listModelGroups().catch(() => undefined)
      : undefined
    return NextResponse.json({
      providerId,
      models,
      capabilities: info.capabilities,
      ...(visionModels ? { visionModels } : null),
      ...(groups?.length ? { groups } : null),
    })
  } catch (err) {
    return NextResponse.json({
      providerId,
      models: [],
      capabilities: info.capabilities,
      error: err instanceof Error ? err.message : "Failed to list models",
    })
  }
}
