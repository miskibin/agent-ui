import "server-only"

import type { ModelOption } from "@/components/ui/model-picker"
import { observedContextWindow } from "@/lib/claude-code-context"
import { hasClaudeCodeBinary } from "@/lib/claude-code-runtime"
import { withPromptContext } from "@/lib/providers/system-prefix"
import type { ClaudeCodeSettings } from "@/lib/settings/schema"
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  PermissionMode,
  ProviderInfo,
} from "@/lib/providers/types"

export const CLAUDE_CODE_PROVIDER_ID = "claudeCode"

/**
 * A static list on purpose: the CLI has no `models` subcommand to ask, and
 * probing the network to fill a picker would put an API call on the path of
 * simply opening the composer.
 *
 * `claude --model` takes either a "latest of this tier" alias or a full id,
 * and both forms are offered because they age differently — an alias follows
 * its tier as it moves, a pinned id does not. Every entry here was checked
 * against the installed CLI by running it and reading back the model the run
 * actually resolved to.
 *
 * `contextLength` is the fallback the composer's meter needs *before* a turn
 * has run: without one it has no denominator and hides itself entirely, and
 * 200k is the window every current Claude model carries. It is only ever a
 * guess — the CLI reports the real one on each result, and
 * `lib/claude-code-context` overrides this with it from then on, which is
 * also how a long-context variant (a `[1m]` model, an enterprise deployment)
 * corrects the number without this list having to know it exists.
 */
const CONTEXT_TOKENS = 200_000

const MODELS: ModelOption[] = [
  { id: "sonnet", name: "Sonnet (latest)", badge: "Alias" },
  { id: "opus", name: "Opus (latest)", badge: "Alias" },
  { id: "haiku", name: "Haiku (latest)", badge: "Alias" },
  { id: "fable", name: "Fable (latest)", badge: "Alias" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
].map((model) => ({ ...model, contextLength: CONTEXT_TOKENS }))

/**
 * All three are real: `read-only` is not a request the model is asked to
 * respect but a deny list the CLI enforces, in subagents too. See
 * `permissionArgs` in `lib/claude-code-agent`.
 */
const CLAUDE_CODE_PERMISSION_MODES: PermissionMode[] = [
  "read-only",
  "edits",
  "full",
]

/**
 * How long `info()` will wait for a cold probe before answering without it.
 * Long enough for a warm CLI to finish starting, short enough that a provider
 * list never feels like it hung.
 */
const PROBE_WAIT_MS = 3_000

/**
 * The static list, with each entry's context window replaced by the one a
 * finished turn actually reported, and with the model the CLI resolved on its
 * own added when it is one this list has never heard of — a model released
 * after this build, or one a settings file pins.
 */
function modelOptions(probedModel?: string): ModelOption[] {
  const options = MODELS.map((model) => {
    const observed = observedContextWindow(model.id)
    return observed ? { ...model, contextLength: observed } : model
  })
  const extra = probedModel?.trim()
  if (!extra || options.some((model) => model.id === extra)) return options
  return [
    {
      id: extra,
      name: extra,
      badge: "Current",
      contextLength: observedContextWindow(extra) ?? CONTEXT_TOKENS,
    },
    ...options,
  ]
}

/** The harness's one-liner, sharpened by whatever the handshake learned. */
function describe(
  workspace: string,
  probe: { ok: boolean; model?: string; version?: string } | undefined
): string {
  const base = `Agentic harness: the claude CLI with its full tool set in ${workspace}.`
  if (!probe?.ok) return base
  const details = [probe.model, probe.version && `CLI ${probe.version}`]
    .filter(Boolean)
    .join(", ")
  return details ? `${base} Signed in — ${details}.` : base
}

/**
 * The local Claude Code CLI (`claude`) as an agentic harness: the full
 * built-in tool set, the project's own `CLAUDE.md`, hooks and MCP servers, and
 * sessions the CLI keeps on disk and resumes by id.
 *
 * `lib/claude-code-agent` owns the subprocess and the protocol translation,
 * and `lib/claude-code-probe` the init handshake behind `info()`. Both are
 * imported lazily, so `child_process` never loads on a request that has
 * nothing to do with this harness.
 */
export function createClaudeCodeProvider(
  settings: ClaudeCodeSettings
): AgentProvider {
  const binPath = settings.binPath.trim()
  const workspace = settings.workspace.trim() || process.cwd()

  const detect = (): { available: boolean; reason?: string } => {
    if (!settings.enabled) {
      return { available: false, reason: "Disabled in settings" }
    }
    if (!hasClaudeCodeBinary(binPath)) {
      return {
        available: false,
        reason: binPath
          ? `No binary at ${binPath}`
          : "`claude` binary not found on PATH",
      }
    }
    return { available: true }
  }

  /**
   * What the CLI said about itself when it last started up.
   *
   * A binary on PATH is not a working harness — it can be signed out, or
   * pointed at a folder it refuses to read — so availability asks the CLI
   * rather than the filesystem. It is bounded, though: the provider list is
   * rendered from `info()`, so a cold probe gets a moment and the answer is
   * given without it if it needs longer, with the result cached for the next
   * call. `run()` never waits for it at all.
   */
  const probe = async (waitMs: number) => {
    if (!settings.enabled || !hasClaudeCodeBinary(binPath)) return undefined
    const { probeClaudeCode } = await import("@/lib/claude-code-probe")
    return probeClaudeCode({ binPath, cwd: workspace, waitMs })
  }

  return {
    async info(): Promise<ProviderInfo> {
      const { available, reason } = detect()
      const handshake = available ? await probe(PROBE_WAIT_MS) : undefined
      // Only a signed-out CLI turns a working install into an unavailable
      // one. A probe that timed out or died for its own reasons proves
      // nothing, and hiding the harness on that evidence is worse than
      // letting the first turn report the real error.
      const signedOut = handshake?.signedOut ? handshake : undefined
      const base: ProviderInfo = {
        id: CLAUDE_CODE_PROVIDER_ID,
        name: "Claude Code",
        description: describe(workspace, handshake),
        capabilities: {
          tools: true,
          // The CLI keeps the transcript in its own session file on disk.
          resume: true,
          // Maps straight onto `--effort`; the app's four ids are a subset of
          // the CLI's low | medium | high | xhigh | max.
          effort: true,
          // `-p` takes a text prompt only. An image has to already be a file
          // on disk for the Read tool to open, which is not what this flag
          // promises the composer.
          vision: false,
          permissionModes: CLAUDE_CODE_PERMISSION_MODES,
          defaultPermissionMode: settings.permissionMode,
        },
        available: available && !signedOut,
      }
      if (base.available) return base
      return {
        ...base,
        unavailableReason: signedOut?.error ?? reason,
        configureBinary:
          process.platform === "win32" &&
          settings.enabled &&
          !hasClaudeCodeBinary(binPath),
      }
    },

    async listModels() {
      // Whatever the last handshake reported is used if it is already in
      // hand; nothing waits for one here, because a picker that opens late is
      // worse than a picker missing one row.
      const handshake = await probe(0)
      return modelOptions(handshake?.model)
    },

    async *run(options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
      // Startup is genuinely slow — settings, hooks, plugins and the project's
      // CLAUDE.md all load before the first token — and the CLI says nothing
      // until its own init line lands.
      yield {
        type: "status",
        stage: "loading",
        text: `Starting Claude Code with ${options.model || "the default model"}`,
      }
      const { runClaudeCodeAgent } = await import("@/lib/claude-code-agent")
      // Resume carries the transcript CLI-side, so `history` is ignored.
      yield* runClaudeCodeAgent({
        prompt: withPromptContext(options.prompt, options),
        model: options.model,
        sessionId: options.sessionId,
        effort: options.effort,
        // Absent means "whatever settings say" — the chat route only sends a
        // mode the chat itself picked.
        permissionMode: options.permissionMode ?? settings.permissionMode,
        // A per-chat folder beats the one workspace from settings.
        workspace: options.cwd?.trim() || workspace,
        binPath,
        signal: options.signal,
      })
    },
  }
}
