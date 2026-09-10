import { healthResponse } from "@/lib/health"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The desktop shell uses this route only to establish that its bundled Next
 * server is listening. It must stay independent of settings and providers:
 * provider discovery can probe or launch local services, which belongs after
 * the window is open rather than on its startup critical path.
 */
/** A token-bearing, intentionally work-free readiness response. */
export function GET() {
  return healthResponse(process.env.AGENT_UI_LAUNCH_TOKEN)
}
