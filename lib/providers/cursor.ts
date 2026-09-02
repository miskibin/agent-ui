import "server-only"

import { existsSync } from "node:fs"

import type { ModelOption } from "@/components/ui/model-picker"
import { hasCursorAgentBinary, isMockForced } from "@/lib/agent-runtime"
import { withPromptContext } from "@/lib/providers/system-prefix"
import type { CursorAgentSettings } from "@/lib/settings/schema"
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  ProviderInfo,
} from "@/lib/providers/types"

export const CURSOR_PROVIDER_ID = "cursorAgent"

/** Familiar models first; the CLI lists dozens of aliases behind them. */
const HEADLINE_IDS = [
  "auto",
  "composer-2.5",
  "cursor-grok-4.6-high",
  "gpt-5.6-sol-high",
  "claude-opus-5-thinking-high",
  "claude-sonnet-5-thinking-high",
  "gemini-3.7-flash-high",
  "gpt-5.5-high",
]

const MODEL_CACHE_MS = 5 * 60 * 1000
let modelCache: { at: number; key: string; models: ModelOption[] } | null = null

/**
 * The local `cursor-agent` CLI. `lib/cursor-agent` owns the spawn + protocol
 * translation and is imported lazily so `child_process` never loads on a
 * request that does not actually reach the binary.
 */
export function createCursorProvider(
  settings: CursorAgentSettings
): AgentProvider {
  const binPath = settings.binPath.trim()

  /**
   * `lib/agent-runtime` resolves the binary from `CURSOR_AGENT_BIN`, so the
   * settings override is applied by pointing that variable at it for this
   * process before anything spawns.
   */
  const applyBinOverride = () => {
    if (binPath) process.env.CURSOR_AGENT_BIN = binPath
  }

  const detect = (): { available: boolean; reason?: string } => {
    if (!settings.enabled) {
      return { available: false, reason: "Disabled in settings" }
    }
    if (binPath) {
      return existsSync(binPath)
        ? { available: true }
        : { available: false, reason: `No binary at ${binPath}` }
    }
    if (isMockForced()) {
      return { available: false, reason: "MOCK_CURSOR_AGENT overrides the CLI" }
    }
    return hasCursorAgentBinary()
      ? { available: true }
      : { available: false, reason: "`agent` binary not found on PATH" }
  }

  return {
    async info(): Promise<ProviderInfo> {
      const { available, reason } = detect()
      const binaryMissing = binPath
        ? !existsSync(binPath)
        : !isMockForced() && !hasCursorAgentBinary()
      return {
        id: CURSOR_PROVIDER_ID,
        name: "Cursor Agent",
        description: "Local `cursor-agent` CLI with full tool access.",
        capabilities: {
          tools: true,
          resume: true,
          // The CLI picks reasoning depth per model; there is no effort flag.
          effort: false,
          vision: false,
        },
        available,
        unavailableReason: reason,
        configureBinary:
          process.platform === "win32" && settings.enabled && binaryMissing,
      }
    },

    async listModels() {
      const key = binPath || "path"
      if (modelCache && modelCache.key === key) {
        if (Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models
      }
      applyBinOverride()
      const { listCursorModels } = await import("@/lib/cursor-agent")
      const listed = await listCursorModels()
      const byId = new Map(listed.map((model) => [model.id, model]))
      const headline = HEADLINE_IDS.filter((id) => byId.has(id)).map((id) => {
        const item = byId.get(id)!
        return {
          id: item.id,
          name: item.name.replace(/\s*\(.*?\)\s*/g, "").trim() || item.name,
          badge: badgeFor(item.id),
        }
      })
      const models: ModelOption[] =
        headline.length > 0
          ? headline
          : listed.slice(0, 20).map((item) => ({
              id: item.id,
              name: item.name,
              badge: badgeFor(item.id),
            }))
      modelCache = { at: Date.now(), key, models }
      return models
    },

    async *run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
      // Spawning the CLI and its first round-trip are silent; say so rather
      // than letting the UI guess that the model is already thinking.
      yield {
        type: "status",
        stage: "connecting",
        text: `Starting cursor-agent with ${options.model}`,
      }
      applyBinOverride()
      const { runCursorAgent } = await import("@/lib/cursor-agent")
      // Resume carries the transcript server-side, so `history` is ignored.
      yield* runCursorAgent({
        prompt: withPromptContext(options.prompt, options),
        model: options.model,
        sessionId: options.sessionId,
        signal: options.signal,
        // The chat's own folder when it has one, else wherever the app runs.
        workspace: options.cwd?.trim() || process.cwd(),
      })
    },
  }
}

function badgeFor(id: string) {
  if (id === "auto") return "Router"
  if (id.startsWith("composer")) return "Cursor"
  if (id.startsWith("cursor-grok") || id.includes("grok")) return "Grok"
  if (id.startsWith("claude")) return "Anthropic"
  if (id.startsWith("gpt") || id.startsWith("codex")) return "OpenAI"
  if (id.startsWith("gemini")) return "Google"
  return undefined
}
