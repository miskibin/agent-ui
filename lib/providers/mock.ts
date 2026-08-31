import type { ModelOption } from "@/components/ui/model-picker"
import { MOCK_MODELS, runMockAgent } from "@/lib/mock-agent"
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  ProviderInfo,
} from "@/lib/providers/types"

export const MOCK_PROVIDER_ID = "mock"

/**
 * The scripted agent from `lib/mock-agent`. It needs nothing installed, so it
 * is always available and is what the app falls back to when no real backend
 * is reachable. Its scenarios exercise reasoning, failing/recovering tool
 * calls and the ask-question flow, which makes it the UI's smoke test.
 */
export function createMockProvider(enabled: boolean): AgentProvider {
  const info: ProviderInfo = {
    id: MOCK_PROVIDER_ID,
    name: "Mock agent",
    description: "Scripted local run — no binary or server required.",
    capabilities: { tools: true, resume: false, effort: true, vision: false },
    available: enabled,
    unavailableReason: enabled ? undefined : "Disabled in settings",
  }

  return {
    info: async () => info,
    listModels: async () => MOCK_MODELS as ModelOption[],
    run: (options: AgentRunOptions): AsyncGenerator<AgentStreamEvent> =>
      runMockAgent({
        prompt: options.prompt,
        model: options.model,
        sessionId: options.sessionId,
        signal: options.signal,
      }),
  }
}
