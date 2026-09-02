import "server-only"

import type { ModelOption } from "@/components/ui/model-picker"
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
 */
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
]

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
 * The local Claude Code CLI (`claude`) as an agentic harness: the full
 * built-in tool set, the project's own `CLAUDE.md`, hooks and MCP servers, and
 * sessions the CLI keeps on disk and resumes by id.
 *
 * `lib/claude-code-agent` owns the subprocess and the protocol translation and
 * is imported lazily, so `child_process` never loads on a request that only
 * asks what this provider is.
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

  return {
    async info(): Promise<ProviderInfo> {
      const { available, reason } = detect()
      const base: ProviderInfo = {
        id: CLAUDE_CODE_PROVIDER_ID,
        name: "Claude Code",
        description: `Agentic harness: the claude CLI with its full tool set in ${workspace}.`,
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
        available,
      }
      if (available) return base
      return {
        ...base,
        unavailableReason: reason,
        configureBinary:
          process.platform === "win32" &&
          settings.enabled &&
          !hasClaudeCodeBinary(binPath),
      }
    },

    async listModels() {
      return MODELS
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
