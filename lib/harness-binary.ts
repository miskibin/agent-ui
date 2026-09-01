import "server-only"

import { acpAgentKey } from "@/lib/providers/acp"
import { CURSOR_PROVIDER_ID } from "@/lib/providers/cursor"
import { PI_PROVIDER_ID } from "@/lib/providers/pi"
import type { AppSettings } from "@/lib/settings/schema"

/** Providers whose missing CLI can be located with the Windows file picker. */
export function isHarnessProviderId(providerId: string): boolean {
  return (
    providerId === PI_PROVIDER_ID ||
    providerId === CURSOR_PROVIDER_ID ||
    acpAgentKey(providerId) !== null
  )
}

export function harnessDisplayName(
  settings: AppSettings,
  providerId: string
): string | null {
  if (providerId === PI_PROVIDER_ID) return "pi"
  if (providerId === CURSOR_PROVIDER_ID) return "Cursor Agent"
  const key = acpAgentKey(providerId)
  const agent = key ? settings.providers.acp.agents[key] : undefined
  if (!agent) return null
  return agent.name.trim() || key
}

/** Writes the picked path onto the field that provider uses to spawn. */
export function setHarnessBinaryPath(
  settings: AppSettings,
  providerId: string,
  binaryPath: string
): AppSettings {
  if (providerId === PI_PROVIDER_ID) {
    return {
      ...settings,
      providers: {
        ...settings.providers,
        pi: { ...settings.providers.pi, binPath: binaryPath },
      },
    }
  }
  if (providerId === CURSOR_PROVIDER_ID) {
    return {
      ...settings,
      providers: {
        ...settings.providers,
        cursorAgent: { ...settings.providers.cursorAgent, binPath: binaryPath },
      },
    }
  }
  const key = acpAgentKey(providerId)
  const agent = key ? settings.providers.acp.agents[key] : undefined
  if (!key || !agent) {
    throw new Error(`${providerId} has no binary path to set`)
  }
  return {
    ...settings,
    providers: {
      ...settings.providers,
      acp: {
        agents: {
          ...settings.providers.acp.agents,
          [key]: { ...agent, command: binaryPath },
        },
      },
    },
  }
}
