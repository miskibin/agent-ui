import "server-only"

import { existsSync } from "node:fs"

import type { ModelOption } from "@/components/ui/model-picker"
import {
  hasCursorAgentBinary,
  isMockForced,
  resolveAgentCommand,
} from "@/lib/agent-runtime"
import { withPromptContext } from "@/lib/providers/system-prefix"
import type { CursorAgentSettings } from "@/lib/settings/schema"
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  PermissionMode,
  ProviderInfo,
} from "@/lib/providers/types"

export const CURSOR_PROVIDER_ID = "cursorAgent"

/**
 * The CLI's own three conversation modes, in the app's vocabulary. `--mode
 * ask` answers without touching the workspace, `--mode plan` writes the change
 * down instead of making it, and no flag at all is the agent that edits — so
 * `edits` is deliberately absent: cursor-agent has no level between "does not
 * write" and "writes anywhere it likes".
 */
const CURSOR_PERMISSION_MODES: PermissionMode[] = ["read-only", "plan", "full"]

function cursorMode(mode: PermissionMode | undefined) {
  if (mode === "read-only") return "ask" as const
  if (mode === "plan") return "plan" as const
  return undefined
}

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

/** The environment's own override, captured before any provider rewrites it. */
const INHERITED_BIN = process.env.CURSOR_AGENT_BIN

const MODEL_CACHE_MS = 5 * 60 * 1000
let modelCache: { at: number; key: string; models: ModelOption[] } | null = null

/**
 * Cursor's CLI is also an ACP agent, and publishes its real model list as one
 * extension method off the handshake — `cursor/list_available_models`, which
 * needs no session and answers in a round-trip. That list is the one Cursor's
 * own picker shows; `agent models` prints dozens of aliases beside it, which
 * is why the scrape below needs `HEADLINE_IDS` to be usable at all. So the
 * extension is tried first and the scrape is what happens when it is not
 * there — an older CLI, a build without the `acp` subcommand.
 *
 * Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.
 */
const CURSOR_ACP_TIMEOUT_MS = 12_000

/** `{ models: [{ value, name }] }`, with everything unusable dropped. */
export function parseCursorAcpModels(
  response: unknown
): { id: string; name: string }[] {
  const models =
    response && typeof response === "object"
      ? (response as { models?: unknown }).models
      : undefined
  if (!Array.isArray(models)) return []
  const seen = new Set<string>()
  const listed: { id: string; name: string }[] = []
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as { value?: unknown; name?: unknown }
    const id = typeof record.value === "string" ? record.value.trim() : ""
    const name = typeof record.name === "string" ? record.name.trim() : ""
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    listed.push({ id, name })
  }
  return listed
}

async function listModelsOverAcp(): Promise<{ id: string; name: string }[]> {
  const { cmd, args } = resolveAgentCommand()
  const { acpExtensionRequest } = await import("@/lib/acp-agent")
  const response = await acpExtensionRequest<unknown>(
    { command: cmd, args: [...args, "acp"], cwd: process.cwd(), env: {} },
    "cursor/list_available_models",
    {},
    CURSOR_ACP_TIMEOUT_MS
  )
  return parseCursorAcpModels(response)
}

/**
 * The scraped list is long and alias-heavy, so the familiar ids are pulled to
 * the front and the rest dropped. The ACP list is already the curated one, so
 * it is passed through whole — filtering it to `HEADLINE_IDS` would throw away
 * exactly the models Cursor added since this constant was written.
 */
function toModelOptions(
  listed: { id: string; name: string }[],
  curated: boolean
): ModelOption[] {
  if (curated) {
    return listed.slice(0, 40).map((item) => ({
      id: item.id,
      name: item.name,
      badge: badgeFor(item.id),
    }))
  }
  const byId = new Map(listed.map((model) => [model.id, model]))
  const headline = HEADLINE_IDS.filter((id) => byId.has(id)).map((id) => {
    const item = byId.get(id)!
    return {
      id: item.id,
      name: item.name.replace(/\s*\(.*?\)\s*/g, "").trim() || item.name,
      badge: badgeFor(item.id),
    }
  })
  if (headline.length > 0) return headline
  return listed.slice(0, 20).map((item) => ({
    id: item.id,
    name: item.name,
    badge: badgeFor(item.id),
  }))
}

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
   *
   * Clearing the setting has to unset it again: the variable outlives the
   * provider that wrote it, so a stale one would keep spawning a binary the
   * user has since removed from settings. What the process was *started* with
   * is the user's own override and is restored rather than dropped.
   */
  const applyBinOverride = () => {
    if (binPath) process.env.CURSOR_AGENT_BIN = binPath
    else if (INHERITED_BIN) process.env.CURSOR_AGENT_BIN = INHERITED_BIN
    else delete process.env.CURSOR_AGENT_BIN
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
          permissionModes: CURSOR_PERMISSION_MODES,
          // No flag = the agent that edits, which is what the CLI does today.
          defaultPermissionMode: "full",
          // …and because it is the absence of a flag, `--resume` cannot undo
          // an `--mode ask` session. See the capability's own note.
          permissionModePerSession: true,
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
      // A CLI without the `acp` subcommand exits before the handshake, and one
      // without the extension answers "method not found" — both land here as a
      // rejection, and both mean "fall back to the scrape".
      const curated = await listModelsOverAcp().catch(() => [])
      const listed =
        curated.length > 0
          ? curated
          : await (async () => {
              const { listCursorModels } = await import("@/lib/cursor-agent")
              return listCursorModels()
            })()
      const models = toModelOptions(listed, curated.length > 0)
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
        mode: cursorMode(options.permissionMode),
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
