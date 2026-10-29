import type { ProviderCapabilities, PermissionMode } from "@/lib/providers/types"

export type SubagentDefaults = { harness?: string; model?: string; effort?: string }

/** Inherit a model only within its harness; ids are not portable across backends. */
export function resolveSubagentDefaults(
  input: SubagentDefaults,
  current: SubagentDefaults = {},
  parent: SubagentDefaults = {},
): SubagentDefaults & { harness: string } {
  const harness = input.harness || current.harness || parent.harness
  if (!harness) throw new Error("Specify harness when delegating outside an existing chat; list_harnesses lists the ids.")
  const inherited = current.harness === harness ? current : parent.harness === harness ? parent : {}
  return { harness, model: input.model ?? inherited.model,
    effort: input.effort ?? inherited.effort ?? (parent.harness === harness ? parent.effort : undefined) }
}

/** A different backend must never turn inherited read-only/plan into write access. */
export function subagentPermission(mode: string | undefined, capabilities: ProviderCapabilities): PermissionMode | undefined {
  if (!mode || !capabilities.tools) return undefined
  if (capabilities.permissionModes?.includes(mode as PermissionMode)) return mode as PermissionMode
  if (mode === "full") return undefined
  throw new Error(`This harness cannot enforce the inherited ${mode} permission mode. Choose a compatible harness.`)
}
