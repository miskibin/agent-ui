import "server-only"

import type { AppSettings } from "@/lib/settings/schema"
import { embedFailure, embedState, pullEmbedModel } from "@/lib/memory/embed"
import { memoryOllama } from "@/lib/memory/ollama"
import type { MemoryStatus } from "@/lib/memory/types"
import { fetchOllamaModels, normalizeBaseUrl } from "@/lib/providers/ollama-api"

/** `embeddinggemma-2` is installed as `embeddinggemma-2:latest`. */
function installed(names: string[], model: string) {
  const wanted = model.includes(":") ? model : `${model}:latest`
  return names.some((name) => name === model || name === wanted)
}

/**
 * Starts Ollama if it is down (`memoryOllama`), and starts the embedding
 * model's download if it is missing — so turning memory on, or opening the
 * app with it on, is the whole setup.
 */
export async function memoryStatus(
  settings: AppSettings,
  options: { retry?: boolean } = {}
): Promise<MemoryStatus> {
  const memory = settings.memory
  const base: MemoryStatus = {
    enabled: memory.enabled,
    reachable: false,
    baseUrl: normalizeBaseUrl(settings.providers.ollama.baseUrl),
    extractionModel: memory.model,
    extractionInstalled: false,
    embedModel: memory.embedModel,
    embed: "unknown",
  }
  if (!memory.enabled) return base

  const baseUrl = await memoryOllama(settings, options)
  if (!baseUrl) return base

  const names = await fetchOllamaModels(baseUrl)
    .then((models) => models.map((model) => model.id))
    .catch(() => [] as string[])
  let embed = embedState(memory.embedModel)
  // A failed pull is not restarted from here: it would fail the same way on
  // every open. The cooldown in `embed.ts` lets a later turn try again.
  if (!installed(names, memory.embedModel) && embed !== "pulling" && embed !== "failed") {
    void pullEmbedModel(baseUrl, memory.embedModel)
    embed = "pulling"
  } else if (embed === "unknown" || embed === "missing") {
    embed = installed(names, memory.embedModel) ? "ready" : embed
  }
  const embedError = embed === "failed" ? embedFailure(memory.embedModel) : undefined
  return {
    ...base,
    reachable: true,
    extractionInstalled: Boolean(memory.model) && installed(names, memory.model),
    embed,
    ...(embedError ? { embedError } : null),
  }
}
