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
import { DEFAULT_DSH_AGENT } from "@/lib/settings/schema"
import type {
  AcpAgentKind,
  AcpRuntime,
  AcpAgentSettings,
  AcpPermissionMode,
  AcpSettings,
  DshSandboxMode,
} from "@/lib/settings/schema"

import { SettingsRow } from "./section"
import { ProviderField, ProviderRow, SetupLink } from "./provider-row"

/** Agents that ship configured: listed first, never removable. */
const BUILT_IN_AGENTS = ["dsh", "tinyagent"]
import {
  StatusBadge,
  statusKey,
  type StatusPhase,
  type ProviderStatus,
} from "./provider-status"

/**
 * The one repeating provider editor: agents that speak the Agent Client
 * Protocol are configured, not coded, so this list is what makes a second or
 * third one possible without a code change. `dsh` ships pre-populated and
 * cannot be removed — everything else is user-added.
 */

const PERMISSION_LABELS: Record<AcpPermissionMode, string> = {
  ask: "Ask me",
  "auto-approve": "Approve everything",
  "auto-approve-reads": "Approve reads only",
  "reject-all": "Reject everything",
}

const PERMISSION_HINTS: Record<AcpPermissionMode, string> = {
  ask: "Permission requests wait for your answer in the chat.",
  "auto-approve": "Automatically approves every permission request.",
  "auto-approve-reads": "Approves reads; blocks writes and commands.",
  "reject-all": "Rejects every permission request.",
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
  loaded: boolean
  onRefresh: (id: string) => void
  refreshing: string | null
}

export function AcpAgentRows({
  acp,
  phase,
  statuses,
  onChange,
  loaded,
  onRefresh,
  refreshing,
}: AcpAgentsProps) {
  // Built-ins first, then whatever the user added, so the list is stable.
  const keys = React.useMemo(() => {
    const all = Object.keys(acp.agents)
    return [
      ...BUILT_IN_AGENTS.filter((key) => all.includes(key)),
      ...all
        .filter((key) => !BUILT_IN_AGENTS.includes(key))
        .sort((a, b) => a.localeCompare(b)),
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
          disabled={!loaded}
          onRefresh={() => onRefresh(`acp:${key}`)}
          refreshing={refreshing === "all" || refreshing === `acp:${key}`}
          agent={acp.agents[key]!}
          phase={phase}
          status={statuses[statusKey(`acp:${key}`)]}
          onPatch={patch}
          onRemove={BUILT_IN_AGENTS.includes(key) ? undefined : remove}
        />
      ))}
      <SettingsRow
        title="Add an ACP agent"
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={add}
            disabled={!loaded}
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
  disabled: boolean
  onRefresh: () => void
  refreshing: boolean
  agent: AcpAgentSettings
  phase: StatusPhase
  status: ProviderStatus | undefined
  onPatch: (key: string, changes: Partial<AcpAgentSettings>) => void
  onRemove?: (key: string) => void
}

function AcpAgentRow({
  agentKey,
  disabled,
  onRefresh,
  refreshing,
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
  // Arguments are one text field over a string[], so the typed text is held
  // raw until the field is left: splitting on every keystroke would swallow
  // the space that separates the argument being typed from the next one.
  // `null` means "not being edited", so a change from elsewhere still shows.
  const [argsDraft, setArgsDraft] = React.useState<string | null>(null)
  const commitArgs = React.useCallback(() => {
    if (argsDraft === null) return
    patch({ args: argsDraft.split(/\s+/).filter(Boolean) })
    setArgsDraft(null)
  }, [argsDraft, patch])
  const isDsh = agent.kind === "dsh"
  const isTiny = agent.kind === "tinyagent"
  const isWsl = agent.runtime === "wsl"

  return (
    <ProviderRow
      id={`acp:${agentKey}`}
      name={agent.name || agentKey}
      enabled={agent.enabled}
      disabled={disabled}
      onEnabledChange={(enabled) => patch({ enabled })}
      status={
        <StatusBadge phase={phase} status={status} enabled={agent.enabled} />
      }
      onRefresh={onRefresh}
      refreshing={refreshing}
      defaultOpen={agent.name === "New ACP agent" && !agent.command}
    >
      <div className="grid gap-2.5">
        {agent.enabled &&
        !status?.available &&
        status?.detail &&
        !/^Disabled/i.test(status.detail) ? (
          <p
            role="status"
            className="text-[12px] break-words text-muted-foreground"
          >
            {status.detail}
          </p>
        ) : null}
        {isTiny ? (
          <SetupLink href="https://github.com/vicgupta/tinyagent#installation">
            Install tinyagent
          </SetupLink>
        ) : isDsh ? (
          <p className="text-[12px] text-muted-foreground">
            Install DeepSeek Harness on the machine running Agent UI. Set its
            command below, then configure a DeepSeek key or a compatible
            endpoint.
          </p>
        ) : (
          <p className="text-[12px] text-muted-foreground">
            Use a command that serves ACP over stdio. Install and authenticate
            it on the machine running Agent UI.
          </p>
        )}

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

        <ProviderField label="Command">
          <Input
            aria-label={`${agent.name || agentKey} command`}
            spellCheck={false}
            autoComplete="off"
            placeholder={
              isDsh
                ? "dsh — or an absolute path to it"
                : isTiny
                  ? isWsl
                    ? "tinyagent — or its Linux path, e.g. ~/.local/bin/tinyagent"
                    : "tinyagent — or an absolute path to it"
                  : "Command, e.g. /usr/local/bin/my-agent"
            }
            className="h-8 font-mono text-[12px]"
            value={agent.command}
            onChange={(event) => patch({ command: event.target.value })}
          />
        </ProviderField>

        <div className="flex flex-wrap items-center gap-2">
          {onRemove ? (
            <Select
              value={agent.kind === "dsh" ? "generic" : agent.kind}
              onValueChange={(kind) => patch({ kind: kind as AcpAgentKind })}
            >
              <SelectTrigger
                size="sm"
                aria-label={`${agent.name || agentKey} kind`}
                className="w-40 text-[12.5px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="generic">Generic ACP agent</SelectItem>
                <SelectItem value="tinyagent">tinyagent</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          <Select
            value={agent.runtime}
            onValueChange={(runtime) =>
              patch({ runtime: runtime as AcpRuntime })
            }
          >
            <SelectTrigger
              size="sm"
              aria-label={`${agent.name || agentKey} runs`}
              className="w-44 text-[12.5px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="native">Runs on this machine</SelectItem>
              <SelectItem value="wsl">Runs inside WSL</SelectItem>
            </SelectContent>
          </Select>
          {isWsl ? (
            <Input
              aria-label={`${agent.name || agentKey} WSL distribution`}
              spellCheck={false}
              autoComplete="off"
              placeholder="Distribution — empty = default"
              className="h-8 w-56 font-mono text-[12px]"
              value={agent.wslDistro}
              onChange={(event) => patch({ wslDistro: event.target.value })}
            />
          ) : null}
        </div>
        {isWsl ? (
          <p className="text-[11.5px] text-muted-foreground">
            Install and sign in inside this WSL distribution. To reach Ollama on
            Windows, use WSL mirrored networking.
          </p>
        ) : null}

        {!isDsh ? (
          <ProviderField label="Arguments">
            <Input
              aria-label={`${agent.name || agentKey} arguments`}
              spellCheck={false}
              autoComplete="off"
              placeholder={
                isTiny
                  ? "Optional extra flags"
                  : "Arguments, space separated — e.g. --acp"
              }
              className="h-8 font-mono text-[12px]"
              value={argsDraft ?? agent.args.join(" ")}
              onChange={(event) => setArgsDraft(event.target.value)}
              onBlur={commitArgs}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur()
              }}
            />
          </ProviderField>
        ) : null}

        <ProviderField label="Workspace">
          <Input
            aria-label={`${agent.name || agentKey} workspace`}
            spellCheck={false}
            autoComplete="off"
            placeholder="Use the chat's folder"
            className="h-8 font-mono text-[12px]"
            value={agent.workspace}
            onChange={(event) => patch({ workspace: event.target.value })}
          />
        </ProviderField>

        {isDsh ? (
          <>
            <ProviderField label="Base URL">
              <Input
                aria-label="DeepSeek Harness base URL"
                spellCheck={false}
                autoComplete="off"
                placeholder="DeepSeek API (default)"
                className="h-8 font-mono text-[12px]"
                value={agent.dsh.baseUrl}
                onChange={(event) =>
                  patch({ dsh: { ...agent.dsh, baseUrl: event.target.value } })
                }
              />
            </ProviderField>
            <ProviderField label="API key">
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
            </ProviderField>
          </>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {isTiny ? null : (
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
                {(Object.keys(PERMISSION_LABELS) as AcpPermissionMode[]).map(
                  (mode) => (
                    <SelectItem key={mode} value={mode}>
                      {PERMISSION_LABELS[mode]}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
          )}

          {isDsh ? (
            <Select
              value={agent.dsh.sandbox}
              onValueChange={(sandbox) =>
                patch({
                  dsh: { ...agent.dsh, sandbox: sandbox as DshSandboxMode },
                })
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
                {(Object.keys(SANDBOX_LABELS) as DshSandboxMode[]).map(
                  (mode) => (
                    <SelectItem key={mode} value={mode}>
                      {SANDBOX_LABELS[mode]}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
          ) : null}
        </div>

        <p className="flex items-start gap-2 text-[11.5px] text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {isTiny
            ? "Can edit files and run commands without approval. Select Read only in the chat to block writes."
            : PERMISSION_HINTS[agent.permissionMode]}
        </p>
      </div>
    </ProviderRow>
  )
}

/** `agent-2`, `agent-3`, … — the key becomes the `acp:<key>` provider id. */
function uniqueKey(agents: Record<string, AcpAgentSettings>): string {
  for (let index = 2; ; index += 1) {
    const key = `agent-${index}`
    if (!(key in agents)) return key
  }
}
