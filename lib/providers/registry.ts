import "server-only"

import { readSettings } from "@/lib/settings/server"
import type { AppSettings } from "@/lib/settings/schema"
import { CURSOR_PROVIDER_ID, createCursorProvider } from "@/lib/providers/cursor"
import { MOCK_PROVIDER_ID, createMockProvider } from "@/lib/providers/mock"
import { OLLAMA_PROVIDER_ID, createOllamaProvider } from "@/lib/providers/ollama"
import { PI_PROVIDER_ID, createPiProvider } from "@/lib/providers/pi"
import type { AgentProvider, ProviderInfo } from "@/lib/providers/types"

/**
 * Providers are built per request from the persisted settings — the settings
 * page can flip a flag or repoint a URL and the next call picks it up without
 * a restart. Ids match the keys under `settings.providers` so the two stay in
 * sync by construction.
 */

export const PROVIDER_IDS = [
  MOCK_PROVIDER_ID,
  CURSOR_PROVIDER_ID,
  OLLAMA_PROVIDER_ID,
  PI_PROVIDER_ID,
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

function build(id: string, settings: AppSettings): AgentProvider | null {
  const providers = settings.providers
  if (id === MOCK_PROVIDER_ID) return createMockProvider(providers.mock.enabled)
  if (id === CURSOR_PROVIDER_ID) return createCursorProvider(providers.cursorAgent)
  if (id === OLLAMA_PROVIDER_ID) return createOllamaProvider(providers.ollama)
  // The harness talks to the same server as the plain Ollama provider, but
  // stays usable when that one is switched off.
  if (id === PI_PROVIDER_ID) {
    return createPiProvider(providers.pi, providers.ollama.baseUrl)
  }
  return null
}

function isEnabled(id: string, settings: AppSettings) {
  const providers = settings.providers
  if (id === MOCK_PROVIDER_ID) return providers.mock.enabled
  if (id === CURSOR_PROVIDER_ID) return providers.cursorAgent.enabled
  if (id === OLLAMA_PROVIDER_ID) return providers.ollama.enabled
  if (id === PI_PROVIDER_ID) return providers.pi.enabled
  return false
}

/**
 * The provider for `id`, or null when it is unknown or switched off. Note that
 * a returned provider may still be unavailable (binary missing, server down) —
 * callers that care should check `info().available` first.
 */
export async function getProvider(id: string): Promise<AgentProvider | null> {
  const settings = await readSettings()
  if (!isEnabled(id, settings)) return null
  return build(id, settings)
}

/**
 * Every known provider with its availability resolved, in picker order.
 * Disabled providers stay in the list (as unavailable) so the UI can explain
 * why they are greyed out instead of silently dropping them.
 */
export async function listProviders(): Promise<ProviderInfo[]> {
  const settings = await readSettings()
  return Promise.all(
    PROVIDER_IDS.map(async (id) => {
      const provider = build(id, settings)
      if (!provider) throw new Error(`Unknown provider ${id}`)
      return provider.info()
    })
  )
}

/** The configured default, falling back to the first available provider. */
export async function resolveActiveProviderId(): Promise<string> {
  const settings = await readSettings()
  const active = settings.providers.active
  if (isEnabled(active, settings)) return active
  const infos = await listProviders()
  return infos.find((info) => info.available)?.id ?? MOCK_PROVIDER_ID
}
