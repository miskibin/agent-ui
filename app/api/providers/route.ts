import { NextResponse } from "next/server"

import { listProviders } from "@/lib/providers/registry"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Every provider plus live availability — drives the composer's picker. */
export async function GET() {
  try {
    return NextResponse.json({ providers: await listProviders() })
  } catch (err) {
    return NextResponse.json(
      {
        providers: [],
        error: err instanceof Error ? err.message : "Failed to list providers",
      },
      { status: 500 }
    )
  }
}
