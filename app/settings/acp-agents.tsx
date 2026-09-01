"use client"

import * as React from "react"
import { Plus, TriangleAlert, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { DEFAULT_DSH_AGENT } from "@/lib/settings/schema"
import type {
  AcpAgentSettings,
  AcpPermissionMode,
  AcpSettings,
  DshSandboxMode,
} from "@/lib/settings/schema"

import { SettingsRow } from "./section"
import { StatusBadge, statusKey, type StatusPhase, type ProviderStatus } from "./provider-status"

/**
 * The one repeating provider editor: agents that speak the Agent Client
 * Protocol are configured, not coded, so this list is what makes a second or
 * third one possible without a code change. `dsh` ships pre-populated and
 * cannot be removed — everything else is user-added.
 */

const PERMISSION_LABELS: Record<AcpPermissionMode, string> = {
  "auto-approve": "Approve everything",
  "auto-approve-reads": "Approve reads only",
  "reject-all": "Reject everything",
}

const PERMISSION_HINTS: Record<AcpPermissionMode, string> = {
  "auto-approve":
    "Every permission request the agent raises is answered “allow”, with no prompt.",
  "auto-approve-reads":
    "Read-only tool calls are allowed; anything that writes or executes is refused.",
  "reject-all":
    "Nothing is ever approved — useful for watching what an agent would do.",
}

const SANDBOX_LABELS: Record<DshSandboxMode, string> = {
  "read-only": "Read-only",
  "workspace-write": "Write inside the workspace",
  "danger-full-access": "Full access (no sandbox)",
}

export type AcpAgentsProps = {
  acp: AcpSettings
  phase: StatusPhase
  statuses: Record<string, ProviderStatus>
  onChange: (acp: AcpSettings) => void
}

export function AcpAgentRows({ acp, phase, statuses, onChange }: AcpAgentsProps) {
  // Built-ins first, then whatever the user added, so the list is stable.
  const keys = React.useMemo(() => {
    const all = Object.keys(acp.agents)
    return [
      ...all.filter((key) => key === "dsh"),
      ...all.filter((key) => key !== "dsh").sort(),
    ]
  }, [acp.agents])

  const patch = React.useCallback(
    (key: string, changes: Partial<AcpAgentSettings>) => {
      const current = acp.agents[key]
      if (!current) return
      onChange({ agents: { ...acp.agents, [key]: { ...current, ...changes } } })
    },
    [acp.agents, onChange]
  )

  const remove = React.useCallback(
    (key: string) => {
      const next = { ...acp.agents }
      delete next[key]
      onChange({ agents: next })
    },
    [acp.agents, onChange]
  )

  const add = React.useCallback(() => {
    const key = uniqueKey(acp.agents)
    onChange({
      agents: {
        ...acp.agents,
        [key]: {
          ...DEFAULT_DSH_AGENT,
          name: "New ACP agent",
          kind: "generic",
          command: "",
          enabled: false,
        },
      },
    })
  }, [acp.agents, onChange])

  return (
    <>
      {keys.map((key) => (
        <AcpAgentRow
          key={key}
          agentKey={key}
          agent={acp.agents[key]!}
          phase={phase}
          status={statuses[statusKey(`acp:${key}`)]}
          onPatch={patch}
          onRemove={key === "dsh" ? undefined : remove}
        />
      ))}
      <SettingsRow
        title="Add an ACP agent"
        description="Any binary that serves the Agent Client Protocol over stdio."
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={add}
            className="text-[12.5px]"
          >
            <Plus />
            Add
          </Button>
        }
      />
    </>
  )
}

type AcpAgentRowProps = {
  agentKey: string
  agent: AcpAgentSettings
  phase: StatusPhase
  status: ProviderStatus | undefined
  onPatch: (key: string, changes: Partial<AcpAgentSettings>) => void
  onRemove?: (key: string) => void
}

function AcpAgentRow({
  agentKey,
  agent,
  phase,
  status,
  onPatch,
  onRemove,
}: AcpAgentRowProps) {
  // Bound per row so the memoized inputs below never see a fresh closure from
  // the parent's map callback.
  const patch = React.useCallback(
    (changes: Partial<AcpAgentSettings>) => onPatch(agentKey, changes),
    [agentKey, onPatch]
  )
  const isDsh = agent.kind === "dsh"
  const inputId = `provider-acp-${agentKey}`

  return (
    <SettingsRow
      title={agent.name || agentKey}
      htmlFor={inputId}
      description={
        isDsh
          ? "DeepSeek Harness over ACP. Answers arrive whole rather than token by token; progress shows as tool calls."
          : `Spawned as \`${agent.command || "(no command)"}\` and driven over ACP stdio.`
      }
      control={
        <>
          <StatusBadge phase={phase} status={status} />
          <Switch
            id={inputId}
            checked={agent.enabled}
            onCheckedChange={(enabled) => patch({ enabled })}
          />
        </>
      }
    >
      <div className="grid gap-2">
        {onRemove ? (
          <div className="flex items-center gap-2">
            <Input
              aria-label="Agent name"
              spellCheck={false}
              autoComplete="off"
              placeholder="Display name"
              className="h-8 text-[12.5px]"
              value={agent.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Remove ${agent.name || agentKey}`}
              onClick={() => onRemove(agentKey)}
              className="shrink-0"
            >
              <Trash2 />
            </Button>
          </div>
        ) : null}

        <Input
          aria-label={`${agent.name || agentKey} command`}
          spellCheck={false}
          autoComplete="off"
          placeholder={isDsh ? "dsh — or an absolute path to it" : "Command, e.g. /usr/local/bin/my-agent"}
          className="h-8 font-mono text-[12px]"
          value={agent.command}
          onChange={(event) => patch({ command: event.target.value })}
        />

        {!isDsh ? (
          <Input
            aria-label={`${agent.name || agentKey} arguments`}
            spellCheck={false}
            autoComplete="off"
            placeholder="Arguments, space separated — e.g. --acp"
            className="h-8 font-mono text-[12px]"
            value={agent.args.join(" ")}
            onChange={(event) =>
              patch({ args: event.target.value.split(/\s+/).filter(Boolean) })
            }
          />
        ) : null}

        <Input
          aria-label={`${agent.name || agentKey} workspace`}
          spellCheck={false}
          autoComplete="off"
          placeholder="Workspace directory — leave empty to use the app's cwd"
          className="h-8 font-mono text-[12px]"
          value={agent.workspace}
          onChange={(event) => patch({ workspace: event.target.value })}
        />

        {isDsh ? (
          <>
            <Input
              aria-label="DeepSeek Harness base URL"
              spellCheck={false}
              autoComplete="off"
              placeholder="OpenAI-compatible base URL (e.g. http://localhost:11434) — empty uses DeepSeek's own API"
              className="h-8 font-mono text-[12px]"
              value={agent.dsh.baseUrl}
              onChange={(event) =>
                patch({ dsh: { ...agent.dsh, baseUrl: event.target.value } })
              }
            />
            <Input
              aria-label="DeepSeek API key"
              type="password"
              spellCheck={false}
              autoComplete="off"
              placeholder="DEEPSEEK_API_KEY — only needed for DeepSeek's own models"
              className="h-8 font-mono text-[12px]"
              value={agent.dsh.apiKey}
              onChange={(event) =>
                patch({ dsh: { ...agent.dsh, apiKey: event.target.value } })
              }
            />
          </>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={agent.permissionMode}
            onValueChange={(mode) =>
              patch({ permissionMode: mode as AcpPermissionMode })
            }
          >
            <SelectTrigger
              size="sm"
              aria-label={`${agent.name || agentKey} permission policy`}
              className="w-52 text-[12.5px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PERMISSION_LABELS) as AcpPermissionMode[]).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {PERMISSION_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {isDsh ? (
            <Select
              value={agent.dsh.sandbox}
              onValueChange={(sandbox) =>
                patch({ dsh: { ...agent.dsh, sandbox: sandbox as DshSandboxMode } })
              }
            >
              <SelectTrigger
                size="sm"
                aria-label="DeepSeek Harness sandbox"
                className="w-56 text-[12.5px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SANDBOX_LABELS) as DshSandboxMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {SANDBOX_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>

        <p className="flex items-start gap-2 text-[11.5px] text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {PERMISSION_HINTS[agent.permissionMode]} The agent runs shell commands
          and edits files in the workspace directory
          {isDsh ? " — and loads a `.env` it finds there" : ""}. Permission
          requests are answered by this policy, never by a prompt.
        </p>
      </div>
    </SettingsRow>
  )
}

/** `agent-2`, `agent-3`, … — the key becomes the `acp:<key>` provider id. */
function uniqueKey(agents: Record<string, AcpAgentSettings>): string {
  for (let index = 2; ; index += 1) {
    const key = `agent-${index}`
    if (!(key in agents)) return key
  }
}
