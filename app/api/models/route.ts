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
    return NextResponse.json({
      providerId,
      models: await provider.listModels(),
      capabilities: info.capabilities,
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
