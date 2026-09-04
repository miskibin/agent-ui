import { NextResponse } from "next/server"

import { listProviders } from "@/lib/providers/registry"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The desktop shell's health check reads this header before it navigates to
 * the port: the sidecar is handed a per-launch token in the environment, and
 * a server that cannot echo it is something else listening on loopback.
 */
const LAUNCH_HEADER = "x-agent-ui-launch"

function launchHeaders(): HeadersInit | undefined {
  const token = process.env.AGENT_UI_LAUNCH_TOKEN
  return token ? { [LAUNCH_HEADER]: token } : undefined
}

/** Every provider plus live availability — drives the composer's picker. */
export async function GET() {
  try {
    return NextResponse.json(
      { providers: await listProviders() },
      { headers: launchHeaders() }
    )
  } catch (err) {
    return NextResponse.json(
      {
        providers: [],
        error: err instanceof Error ? err.message : "Failed to list providers",
      },
      { status: 500, headers: launchHeaders() }
    )
  }
}
