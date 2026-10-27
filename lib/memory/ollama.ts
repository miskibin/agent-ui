import "server-only"

import type { AppSettings } from "@/lib/settings/schema"
import { allowOllamaRespawn, ensureOllama } from "@/lib/providers/ollama-autostart"
import { normalizeBaseUrl, probeOllama } from "@/lib/providers/ollama-api"

/**
 * The Ollama server memory runs on, or undefined when there is none.
 *
 * Memory is Ollama's whether or not Ollama is a chat harness here: the
 * extractor and the embedder both run on it. So this starts a local server
 * the same way the harness does (`ensureOllama`, once per process), and a
 * caller that gets undefined treats memory as off — no facts injected, nothing
 * extracted — rather than half-working on whatever it can reach.
 *
 * `retry` is the dialog's "Try again": it re-arms the one spawn the process
 * allows, because the user just said they want another attempt.
 */
export async function memoryOllama(
  settings: AppSettings,
  options: { retry?: boolean } = {}
): Promise<string | undefined> {
  const baseUrl = normalizeBaseUrl(settings.providers.ollama.baseUrl)
  if (!baseUrl) return undefined
  if (options.retry) allowOllamaRespawn(baseUrl)
  const reachable = (await ensureOllama(baseUrl)) || (await probeOllama(baseUrl))
  return reachable ? baseUrl : undefined
}
