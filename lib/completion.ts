import "server-only"

import { parseJsonObject } from "@/lib/json-rescue"
import { splitModelId } from "@/lib/model-providers/ids"
import { enabledModelSources } from "@/lib/model-providers/server"
import {
  fetchOllamaModelContext,
  normalizeBaseUrl,
} from "@/lib/providers/ollama-api"
import type { AppSettings } from "@/lib/settings/schema"
import { estimateTokens, fitMessagesToContext } from "@/lib/token-estimate"

/**
 * One short, non-streaming completion against any configured model source —
 * the local Ollama server or a hosted OpenAI-compatible endpoint — for the
 * app's own small jobs (a chat title, say). Nothing here streams, resumes or
 * calls tools; those belong to the providers.
 */

const TIMEOUT_MS = 20_000

/**
 * What Ollama serves when nobody asks for a window.
 *
 * 4096, whatever the weights allow — the number is Ollama's, not the model's.
 * So a commit message written from a 50k-character patch is refused with
 * "request (17262 tokens) exceeds the available context size (4096 tokens)"
 * by a model with 128k of context sitting unused. Every job in this file
 * assembles more evidence than that on a good day, which made the whole
 * feature look broken on exactly the setup it was meant for: a local model.
 */
const OLLAMA_DEFAULT_NUM_CTX = 4_096

/** The estimate is an estimate; never fill the window to its last token. */
const CONTEXT_HEADROOM_TOKENS = 256

/** Windows are asked for in whole steps — a bigger one costs memory to serve. */
const NUM_CTX_STEP = 1_024

/**
 * The window to ask for, and the messages that will fit in it.
 *
 * Three cases, in order. The prompt fits Ollama's default: ask for nothing and
 * behave exactly as before. It fits the model but not the default: ask for a
 * window big enough, rounded up a step. It fits neither: the evidence is
 * trimmed to the model's ceiling rather than sent to be refused — a commit
 * message written from half a patch is worth more than a 400.
 *
 * A server that will not say what the model can take is taken at its default,
 * which is the safe direction: `num_ctx` above the architecture's own maximum
 * is the one way to turn a working request into a failing one.
 */
async function fitToOllamaContext(
  baseUrl: string,
  model: string,
  messages: CompletionMessage[],
  maxTokens: number
): Promise<{ messages: CompletionMessage[]; numCtx?: number }> {
  const prompt = messages.reduce(
    (sum, message) => sum + estimateTokens(message.content),
    0
  )
  const needed = prompt + maxTokens + CONTEXT_HEADROOM_TOKENS
  if (needed <= OLLAMA_DEFAULT_NUM_CTX) return { messages }

  const ceiling =
    (await fetchOllamaModelContext(baseUrl, model)) ?? OLLAMA_DEFAULT_NUM_CTX
  const numCtx = Math.min(
    ceiling,
    Math.ceil(needed / NUM_CTX_STEP) * NUM_CTX_STEP
  )
  if (needed <= numCtx) return { messages, numCtx }
  return {
    messages: fitMessagesToContext(
      messages,
      numCtx - maxTokens - CONTEXT_HEADROOM_TOKENS
    ),
    numCtx,
  }
}

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
    const fitted = await fitToOllamaContext(baseUrl, model, messages, maxTokens)
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: fitted.messages,
        stream: false,
        think: false,
        options: {
          temperature: 0.2,
          num_predict: maxTokens,
          ...(fitted.numCtx ? { num_ctx: fitted.numCtx } : null),
        },
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

/** Longest chat title kept; the sidebar row is narrow. */
export const MAX_TITLE_CHARS = 60

/**
 * Whatever a model said, as a sidebar row.
 *
 * The JSON is unwrapped *before* anything is truncated, which is the order
 * that matters: a model asked for `{"title": "…"}` that answers with prose
 * around it would otherwise be clipped mid-object, and the user would end up
 * with a chat called `{"title": "Fix the streaming rec`. A model that ignored
 * the JSON request and answered with the title alone takes the same path —
 * `extractJsonObject` finds no object, and the raw line is cleaned as before.
 *
 * Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License,
 * (c) 2026 T3 Tools Inc.
 */
export function sanitizeTitle(raw: string): string {
  const parsed = parseJsonObject<{ title?: unknown }>(raw)
  const text = typeof parsed?.title === "string" ? parsed.title : raw
  const cleaned = (text.split("\n").find((line) => line.trim()) ?? "")
    .replace(/^title:\s*/i, "")
    .replace(/^["'“”‘’\s]+|["'“”‘’\s.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.length <= MAX_TITLE_CHARS
    ? cleaned
    : `${cleaned.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
}
