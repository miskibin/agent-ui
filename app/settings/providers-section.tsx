"use client"

import * as React from "react"
import { RotateCw, TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import type { PermissionMode } from "@/lib/providers/types"
import type { AppSettings } from "@/lib/settings/schema"

import { AcpAgentRows } from "./acp-agents"
import { StatusBadge, statusKey, useProviderStatus } from "./provider-status"
import { SettingsRow, SettingsSection } from "./section"
import type { AppSettingsApi } from "./use-app-settings"

const BUILT_IN_PROVIDERS = [
  { id: "mock", label: "Mock" },
  { id: "ollama", label: "Ollama" },
  { id: "pi", label: "pi" },
  { id: "cursorAgent", label: "Cursor Agent" },
  { id: "claudeCode", label: "Claude Code" },
] as const

/** Each label is what the CLI's flags actually enforce, not a suggestion. */
const CLAUDE_CODE_MODES = [
  { id: "read-only", label: "Read only" },
  { id: "edits", label: "Edit files" },
  { id: "full", label: "Full access" },
] as const

export function ProvidersSection({
  settings,
  loaded,
  update,
  flush,
}: AppSettingsApi) {
  const { phase, map, refresh } = useProviderStatus()
  const [testing, setTesting] = React.useState(false)
  const providers = settings.providers

  const setProviders = React.useCallback(
    (patch: Partial<AppSettings["providers"]>) =>
      update((current) => ({
        ...current,
        providers: { ...current.providers, ...patch },
      })),
    [update]
  )

  const setAcp = React.useCallback(
    (acp: AppSettings["providers"]["acp"]) => setProviders({ acp }),
    [setProviders]
  )

  // ACP agents are configured rather than coded, so the default-provider list
  // has to be derived from settings instead of a static const.
  const choices = React.useMemo(
    () => [
      ...BUILT_IN_PROVIDERS.map((provider) => ({ ...provider })),
      ...Object.entries(providers.acp.agents).map(([key, agent]) => ({
        id: `acp:${key}`,
        label: agent.name || key,
      })),
    ],
    [providers.acp.agents]
  )

  const testOllama = React.useCallback(async () => {
    setTesting(true)
    // The status route reads settings.json, so a base URL typed a moment ago
    // has to be written before the probe — otherwise this tests the old one.
    await flush()
    const next = await refresh()
    setTesting(false)
    if (!next) {
      toast.error("Provider status is unavailable.")
      return
    }
    const status = next[statusKey("ollama")]
    if (status?.available) toast.success("Ollama is reachable.")
    else toast.error(status?.detail ?? "Ollama did not respond.")
  }, [flush, refresh])

  return (
    <SettingsSection
      id="providers"
      title="Harnesses"
      description="The agent backends that run your chats — each harness brings its own tools and session handling."
    >
      <SettingsRow
        title="Default provider"
        description="Used for new chats."
        control={
          loaded ? (
            <Select
              value={providers.active}
              onValueChange={(active) => setProviders({ active })}
            >
              <SelectTrigger size="sm" className="w-40 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Skeleton className="h-8 w-40" />
          )
        }
      />

      <SettingsRow
        title="Mock"
        htmlFor="provider-mock"
        description="Scripted local agent. No network, no binaries."
        control={
          <Switch
            id="provider-mock"
            checked={providers.mock.enabled}
            onCheckedChange={(enabled) => setProviders({ mock: { enabled } })}
          />
        }
      />

      <SettingsRow
        title="Ollama"
        htmlFor="provider-ollama"
        description="Local models over the Ollama HTTP API."
        control={
          <>
            <StatusBadge phase={phase} status={map[statusKey("ollama")]} />
            <Switch
              id="provider-ollama"
              checked={providers.ollama.enabled}
              onCheckedChange={(enabled) =>
                setProviders({ ollama: { ...providers.ollama, enabled } })
              }
            />
          </>
        }
      >
        <div className="flex items-center gap-2">
          <Input
            aria-label="Ollama base URL"
            spellCheck={false}
            autoComplete="off"
            placeholder="http://localhost:11434"
            className="h-8 text-[12.5px]"
            value={providers.ollama.baseUrl}
            onChange={(event) =>
              setProviders({
                ollama: { ...providers.ollama, baseUrl: event.target.value },
              })
            }
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={testing}
            onClick={() => void testOllama()}
            className="shrink-0 text-[12.5px]"
          >
            <RotateCw className={testing ? "animate-spin" : undefined} />
            Test
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow
        title="pi"
        htmlFor="provider-pi"
        description="Agentic harness: the pi CLI drives the Ollama models above and every enabled model provider with read, write, edit and bash tools."
        control={
          <>
            <StatusBadge phase={phase} status={map[statusKey("pi")]} />
            <Switch
              id="provider-pi"
              checked={providers.pi.enabled}
              onCheckedChange={(enabled) =>
                setProviders({ pi: { ...providers.pi, enabled } })
              }
            />
          </>
        }
      >
        <div className="grid gap-2">
          <Input
            aria-label="pi binary path"
            spellCheck={false}
            autoComplete="off"
            placeholder="Leave empty to autodetect pi on PATH"
            className="h-8 font-mono text-[12px]"
            value={providers.pi.binPath}
            onChange={(event) =>
              setProviders({
                pi: { ...providers.pi, binPath: event.target.value },
              })
            }
          />
          <Input
            aria-label="pi workspace"
            spellCheck={false}
            autoComplete="off"
            placeholder="Workspace directory — leave empty to use the app's cwd"
            className="h-8 font-mono text-[12px]"
            value={providers.pi.workspace}
            onChange={(event) =>
              setProviders({
                pi: { ...providers.pi, workspace: event.target.value },
              })
            }
          />
          <p className="flex items-start gap-2 text-[11.5px] text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            pi runs shell commands and edits files in this directory with no
            sandbox and no approval prompt.
          </p>
        </div>
      </SettingsRow>

      <SettingsRow
        title="Cursor Agent"
        htmlFor="provider-cursor"
        description="Drives the cursor-agent CLI in a subprocess."
        control={
          <>
            <StatusBadge phase={phase} status={map[statusKey("cursorAgent")]} />
            <Switch
              id="provider-cursor"
              checked={providers.cursorAgent.enabled}
              onCheckedChange={(enabled) =>
                setProviders({
                  cursorAgent: { ...providers.cursorAgent, enabled },
                })
              }
            />
          </>
        }
      >
        <Input
          aria-label="Cursor Agent binary path"
          spellCheck={false}
          autoComplete="off"
          placeholder="Leave empty to autodetect on PATH"
          className="h-8 font-mono text-[12px]"
          value={providers.cursorAgent.binPath}
          onChange={(event) =>
            setProviders({
              cursorAgent: {
                ...providers.cursorAgent,
                binPath: event.target.value,
              },
            })
          }
        />
      </SettingsRow>

      <SettingsRow
        title="Claude Code"
        htmlFor="provider-claude-code"
        description="Agentic harness: the claude CLI with its full tool set, your project's CLAUDE.md, hooks and MCP servers."
        control={
          <>
            <StatusBadge phase={phase} status={map[statusKey("claudeCode")]} />
            <Switch
              id="provider-claude-code"
              checked={providers.claudeCode.enabled}
              onCheckedChange={(enabled) =>
                setProviders({
                  claudeCode: { ...providers.claudeCode, enabled },
                })
              }
            />
          </>
        }
      >
        <div className="grid gap-2">
          <Input
            aria-label="Claude Code binary path"
            spellCheck={false}
            autoComplete="off"
            placeholder="Leave empty to autodetect claude on PATH"
            className="h-8 font-mono text-[12px]"
            value={providers.claudeCode.binPath}
            onChange={(event) =>
              setProviders({
                claudeCode: {
                  ...providers.claudeCode,
                  binPath: event.target.value,
                },
              })
            }
          />
          <Input
            aria-label="Claude Code workspace"
            spellCheck={false}
            autoComplete="off"
            placeholder="Workspace directory — leave empty to use the app's cwd"
            className="h-8 font-mono text-[12px]"
            value={providers.claudeCode.workspace}
            onChange={(event) =>
              setProviders({
                claudeCode: {
                  ...providers.claudeCode,
                  workspace: event.target.value,
                },
              })
            }
          />
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="claude-code-permission"
              className="text-[11.5px] text-muted-foreground"
            >
              Default permission for new chats
            </label>
            <Select
              value={providers.claudeCode.permissionMode}
              onValueChange={(mode) =>
                setProviders({
                  claudeCode: {
                    ...providers.claudeCode,
                    permissionMode: mode as PermissionMode,
                  },
                })
              }
            >
              <SelectTrigger
                id="claude-code-permission"
                size="sm"
                className="w-36 shrink-0 text-[12.5px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLAUDE_CODE_MODES.map((mode) => (
                  <SelectItem key={mode.id} value={mode.id}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="flex items-start gap-2 text-[11.5px] text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            Read only genuinely blocks the editing and shell tools; the other
            two let Claude write files — and, on full access, run commands —
            without an approval prompt. A chat can pick its own mode.
          </p>
        </div>
      </SettingsRow>

      <AcpAgentRows
        acp={providers.acp}
        phase={phase}
        statuses={map}
        onChange={setAcp}
      />

      {phase === "unavailable" ? (
        <p className="flex items-center gap-2 bg-muted/40 px-4 py-2.5 text-[11.5px] text-muted-foreground">
          <TriangleAlert className="size-3.5 shrink-0" />
          Provider status is unavailable — <code>/api/providers</code> isn&apos;t
          responding yet. Settings still save.
        </p>
      ) : null}
    </SettingsSection>
  )
}
