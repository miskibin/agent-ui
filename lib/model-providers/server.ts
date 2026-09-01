import "server-only"

import {
  MODEL_PROVIDER_PRESETS,
  RESERVED_MODEL_PROVIDER_SLUGS,
} from "@/lib/model-providers/presets"
import type { AppSettings } from "@/lib/settings/schema"

/**
 * The server-side catalog over `settings.modelProviders`: which configured
 * sources are usable this request, and what models each one offers.
 *
 * API keys live here and nowhere near the client — a route asks this module
 * for a source and forwards the answer, so the key itself never has to cross
 * the wire twice.
 */

const MODELS_TIMEOUT_MS = 5_000

export type ModelSource = {
  slug: string
  name: string
  baseUrl: string
  apiKey: string
  /** Manual model ids; empty means "ask the endpoint". */
  models: string[]
}

type ModelsResponse = {
  data?: Array<{ id?: unknown; name?: unknown }>
}

/**
 * Enabled entries that have somewhere to talk to, presets in their shipped
 * order first (so the pickers read the same way everywhere) and user-added
 * ones after, alphabetically.
 */
export function enabledModelSources(settings: AppSettings): ModelSource[] {
  const entries = settings.modelProviders ?? {}
  const presetOrder = MODEL_PROVIDER_PRESETS.map((preset) => preset.slug)
  const customs = Object.keys(entries)
    .filter(
      (slug) =>
        !presetOrder.includes(slug) &&
        !RESERVED_MODEL_PROVIDER_SLUGS.includes(slug)
    )
    .sort((a, b) => a.localeCompare(b))
  const sources: ModelSource[] = []
  for (const slug of [...presetOrder, ...customs]) {
    const entry = entries[slug]
    if (!entry?.enabled || !entry.baseUrl) continue
    sources.push({
      slug,
      name: entry.name || slug,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      models: entry.models,
    })
  }
  return sources
}

/**
 * A manual `models` list wins — it is how someone points the app at an
 * endpoint whose `/models` is missing, gated or enormous. Otherwise the
 * OpenAI-compatible catalog is fetched. Throws with a message meant for a
 * toast: this one *is* an error, unlike a provider being merely unreachable.
 *
 * The key goes out three ways at once: `Authorization: Bearer` is what every
 * OpenAI-compatible catalog wants, and `x-api-key` + `anthropic-version` are
 * what Anthropic's `/v1/models` wants instead — it rejects a plain bearer.
 * The extra two headers are ignored everywhere else, which is cheaper than
 * special-casing one preset.
 */
export async function listSourceModels(
  source: ModelSource
): Promise<Array<{ id: string; name: string }>> {
  if (source.models.length > 0) {
    return dedupeById(source.models.map((id) => ({ id, name: id })))
  }

  let res: Response
  try {
    res = await fetch(`${source.baseUrl}/models`, {
      cache: "no-store",
      headers: source.apiKey
        ? {
            Authorization: `Bearer ${source.apiKey}`,
            "x-api-key": source.apiKey,
            "anthropic-version": "2023-06-01",
          }
        : undefined,
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(reachErrorMessage(err, source))
  }
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? `${source.name} rejected the API key (${res.status})`
        : `${source.name} /models failed (${res.status})`
    )
  }

  let data: ModelsResponse
  try {
    data = (await res.json()) as ModelsResponse
  } catch {
    throw new Error(`${source.name} returned a malformed model list`)
  }
  const models = (data.data ?? [])
    .map((entry) => {
      const id = typeof entry.id === "string" ? entry.id.trim() : ""
      if (!id) return null
      const name = typeof entry.name === "string" ? entry.name.trim() : ""
      return { id, name: name || id }
    })
    .filter((model): model is { id: string; name: string } => model !== null)
  return dedupeById(models)
}

function dedupeById(models: Array<{ id: string; name: string }>) {
  const byId = new Map<string, { id: string; name: string }>()
  for (const model of models) {
    const id = model.id.trim()
    if (!id || byId.has(id)) continue
    byId.set(id, { id, name: model.name || id })
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function reachErrorMessage(err: unknown, source: ModelSource) {
  const message = err instanceof Error ? err.message : String(err)
  if (/timed? ?out|abort/i.test(message)) {
    return `${source.name} did not answer within ${MODELS_TIMEOUT_MS / 1000}s`
  }
  return /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)
    ? `Could not reach ${source.name} at ${source.baseUrl}`
    : message
}
