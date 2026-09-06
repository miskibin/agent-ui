import "server-only"

import { splitModelId } from "@/lib/model-providers/ids"
import { enabledModelSources } from "@/lib/model-providers/server"
import { normalizeBaseUrl } from "@/lib/providers/ollama-api"
import type { AppSettings } from "@/lib/settings/schema"

/**
 * One short, non-streaming completion against any configured model source —
 * the local Ollama server or a hosted OpenAI-compatible endpoint — for the
 * app's own small jobs (a chat title, say). Nothing here streams, resumes or
 * calls tools; those belong to the providers.
 */

const TIMEOUT_MS = 20_000

export type CompletionMessage = { role: "system" | "user"; content: string }

/** True when `modelId` names a source this helper can reach with `settings`. */
export function canComplete(settings: AppSettings, modelId: string): boolean {
  const { source } = splitModelId(modelId)
  if (source === "ollama") return settings.providers.ollama.enabled
  return enabledModelSources(settings).some((entry) => entry.slug === source)
}

/**
 * What the endpoint actually said, rather than just the number it said it
 * with. A pulled-and-since-deleted Ollama model answers 404 with `model
 * "gemma4:e4b" not found, try pulling it first` — which names the fix, where a
 * bare "(404)" leaves the user guessing which thing was not found.
 */
async function failureText(res: Response, label: string): Promise<string> {
  const body = await res.text().catch(() => "")
  let detail = body.trim()
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { message?: string }
    }
    const message =
      typeof parsed.error === "string" ? parsed.error : parsed.error?.message
    if (message) detail = message
  } catch {
    /* not JSON — the raw body is the detail */
  }
  detail = detail.replace(/\s+/g, " ").slice(0, 300)
  return detail ? `${label} (${res.status}): ${detail}` : `${label} (${res.status})`
}

export async function complete(
  settings: AppSettings,
  modelId: string,
  messages: CompletionMessage[],
  options: { maxTokens?: number } = {}
): Promise<string> {
  const { source, model } = splitModelId(modelId)
  const maxTokens = options.maxTokens ?? 200
  const signal = AbortSignal.timeout(TIMEOUT_MS)

  if (source === "ollama") {
    const baseUrl = normalizeBaseUrl(settings.providers.ollama.baseUrl)
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        think: false,
        options: { temperature: 0.2, num_predict: maxTokens },
      }),
      cache: "no-store",
      signal,
    })
    if (!res.ok) throw new Error(await failureText(res, "Ollama /api/chat failed"))
    const data = (await res.json()) as { message?: { content?: string } }
    return data.message?.content?.trim() ?? ""
  }

  const entry = enabledModelSources(settings).find((item) => item.slug === source)
  if (!entry) throw new Error(`No configured model provider named "${source}"`)
  const res = await fetch(`${entry.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(entry.apiKey
        ? {
            Authorization: `Bearer ${entry.apiKey}`,
            "x-api-key": entry.apiKey,
            "anthropic-version": "2023-06-01",
          }
        : null),
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    }),
    cache: "no-store",
    signal,
  })
  if (!res.ok) {
    throw new Error(
      await failureText(res, `${entry.name} chat/completions failed`)
    )
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content?.trim() ?? ""
}
