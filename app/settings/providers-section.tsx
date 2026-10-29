"use client"

import * as React from "react"
import { TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import { HarnessLogo } from "@/components/provider-logo"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import type { PermissionMode } from "@/lib/providers/types"
import type { AppSettings } from "@/lib/settings/schema"

import { AcpAgentRows } from "./acp-agents"
import {
  ProviderField,
  ProviderRow,
  RefreshButton,
  SetupCommand,
  SetupLink,
} from "./provider-row"
import { StatusBadge, statusKey, useProviderStatus } from "./provider-status"
import { SettingsRow, SettingsSection } from "./section"
import type { AppSettingsApi } from "./use-app-settings"

const CLIS = [
  {
    id: "pi",
    name: "pi",
    binary: "pi",
    docs: "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
    install: "npm install -g @mariozechner/pi-coding-agent",
    hint: "Uses Ollama and your model providers. Add API keys in Model providers, then refresh.",
  },
  {
    id: "cursorAgent",
    name: "Cursor Agent",
    binary: "cursor-agent",
    docs: "https://cursor.com/docs/cli/installation",
    login: "agent login",
  },
  {
    id: "claudeCode",
    name: "Claude Code",
    binary: "claude",
    docs: "https://code.claude.com/docs/en/setup",
    login: "claude auth login",
  },
  {
    id: "codex",
    name: "Codex",
    binary: "codex",
    docs: "https://developers.openai.com/codex/cli",
    install: "npm install -g @openai/codex",
    login: "codex login",
    hint: "Your existing CLI login is reused. Custom model providers must support the Responses API.",
  },
] as const
const BUILT_IN_PROVIDERS = [
  { id: "mock", label: "Mock" },
  { id: "ollama", label: "Ollama" },
  ...CLIS.map(({ id, name }) => ({ id, label: name })),
]
const PERMISSION_MODES = [
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
  const { phase, map, refresh } = useProviderStatus(loaded)
  const [refreshing, setRefreshing] = React.useState<string | null>(null)
  const refreshLock = React.useRef(false)
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
  const choices = React.useMemo(
    () => [
      ...BUILT_IN_PROVIDERS,
      ...Object.entries(providers.acp.agents).map(([key, agent]) => ({
        id: `acp:${key}`,
        label: agent.name || key,
      })),
    ],
    [providers.acp.agents]
  )

  const refreshProviders = React.useCallback(
    async (id?: string) => {
      if (refreshLock.current) return
      refreshLock.current = true
      setRefreshing(id ?? "all")
      try {
        // The probe must see even a URL/path typed immediately before clicking.
        await flush()
        const statuses = await refresh(true)
        if (!statuses) {
          toast.error("Couldn't refresh providers. Try again.")
          return
        }
        const ids = id ? [id] : Object.keys(statuses)
        const outcomes = await Promise.all(
          ids
            .filter((key) => statuses[statusKey(key)]?.available)
            .map(async (key) => {
              // Status keys are normalized; map them back to the runtime provider ids.
              const providerId = choices.find(
                (choice) => statusKey(choice.id) === statusKey(key)
              )?.id
              if (!providerId) return null
              try {
                const res = await fetch(
                  `/api/models?provider=${encodeURIComponent(providerId)}&refresh=1`,
                  { cache: "no-store", signal: AbortSignal.timeout(30_000) }
                )
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                const data = (await res.json()) as { error?: string }
                return data.error
                  ? `${choices.find((choice) => choice.id === providerId)?.label}: ${data.error}`
                  : null
              } catch {
                return `Couldn't refresh models for ${providerId}.`
              }
            })
        )
        const error = outcomes.find(Boolean)
        if (error) toast.error(error)
      } catch {
        // Saving reports its own error; never probe the old persisted config.
      } finally {
        refreshLock.current = false
        setRefreshing(null)
      }
    },
    [flush, refresh, choices]
  )

  return (
    <SettingsSection
      id="providers"
      title="Harnesses"
      action={
        <RefreshButton
          name="provider status"
          busy={refreshing !== null || phase === "loading"}
          disabled={!loaded}
          onClick={() => void refreshProviders()}
        />
      }
    >
      <SettingsRow
        title="Default for new chats"
        control={
          loaded ? (
            <Select
              value={providers.active}
              onValueChange={(active) => setProviders({ active })}
            >
              <SelectTrigger
                size="sm"
                aria-label="Default provider"
                className="w-40 text-[12.5px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    <span className="flex items-center gap-2">
                      <HarnessLogo
                        providerId={provider.id}
                        name={provider.label}
                      />
                      {provider.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Skeleton className="h-8 w-40" />
          )
        }
      />

      {CLIS.map((cli) => {
        const config = providers[cli.id]
        const status = map[statusKey(cli.id)]
        return (
          <ProviderRow
            key={cli.id}
            id={cli.id}
            name={cli.name}
            enabled={config.enabled}
            disabled={!loaded}
            onEnabledChange={(enabled) =>
              setProviders({ [cli.id]: { ...config, enabled } })
            }
            status={
              <StatusBadge
                phase={phase}
                status={status}
                enabled={config.enabled}
              />
            }
            onRefresh={() => void refreshProviders(cli.id)}
            refreshing={refreshing === "all" || refreshing === cli.id}
          >
            <div className="grid gap-4">
              {config.enabled &&
              status?.detail &&
              !status.available &&
              !/^Disabled/i.test(status.detail) ? (
                <p
                  role="status"
                  className="text-[12px] break-words text-muted-foreground"
                >
                  {status.detail}
                </p>
              ) : null}
              <div className="grid gap-2">
                <SetupLink href={cli.docs}>Install {cli.name}</SetupLink>
                {"install" in cli ? (
                  <SetupCommand command={cli.install} />
                ) : null}
                {"login" in cli ? <SetupCommand command={cli.login} /> : null}
                {"hint" in cli ? (
                  <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                    {cli.hint}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-2.5">
                <ProviderField label="Binary path">
                  <Input
                    aria-label={`${cli.name} binary path`}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={`${cli.binary} (auto-detect)`}
                    className="h-8 font-mono text-[12px]"
                    value={config.binPath}
                    onChange={(event) =>
                      setProviders({
                        [cli.id]: { ...config, binPath: event.target.value },
                      })
                    }
                  />
                </ProviderField>
                {cli.id !== "cursorAgent" ? (
                  <ProviderField label="Workspace">
                    <Input
                      aria-label={`${cli.name} workspace`}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="Use the chat's folder"
                      className="h-8 font-mono text-[12px]"
                      value={providers[cli.id].workspace}
                      onChange={(event) =>
                        setProviders({
                          [cli.id]: {
                            ...config,
                            workspace: event.target.value,
                          },
                        })
                      }
                    />
                  </ProviderField>
                ) : null}
                {cli.id === "claudeCode" || cli.id === "codex" ? (
                  <ProviderField
                    label="Permissions"
                    htmlFor={`${cli.id}-permissions`}
                  >
                    <Select
                      value={providers[cli.id].permissionMode}
                      onValueChange={(permissionMode) =>
                        setProviders({
                          [cli.id]: {
                            ...config,
                            permissionMode: permissionMode as PermissionMode,
                          },
                        })
                      }
                    >
                      <SelectTrigger
                        id={`${cli.id}-permissions`}
                        size="sm"
                        aria-label={`${cli.name} default permissions`}
                        className="w-full text-[12.5px]"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PERMISSION_MODES.map((mode) => (
                          <SelectItem key={mode.id} value={mode.id}>
                            {mode.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </ProviderField>
                ) : null}
              </div>
              {cli.id === "pi" ? (
                <p className="flex items-start gap-2 text-[11.5px] text-muted-foreground">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  pi can edit files and run commands without a sandbox or
                  approval prompt.
                </p>
              ) : null}
            </div>
          </ProviderRow>
        )
      })}

      <ProviderRow
        id="ollama"
        name="Ollama"
        enabled={providers.ollama.enabled}
        disabled={!loaded}
        onEnabledChange={(enabled) =>
          setProviders({ ollama: { ...providers.ollama, enabled } })
        }
        status={
          <StatusBadge
            phase={phase}
            status={map[statusKey("ollama")]}
            enabled={providers.ollama.enabled}
          />
        }
        onRefresh={() => void refreshProviders("ollama")}
        refreshing={refreshing === "all" || refreshing === "ollama"}
      >
        <div className="grid gap-3">
          <SetupLink href="https://ollama.com/download">
            Install Ollama
          </SetupLink>
          <SetupCommand command="ollama serve" />
          <p className="text-[11.5px] text-muted-foreground">
            Download a model in Ollama, then refresh. Local servers start
            automatically when available.
          </p>
          <ProviderField label="Server URL">
            <Input
              aria-label="Ollama base URL"
              spellCheck={false}
              autoComplete="off"
              placeholder="http://localhost:11434"
              className="h-8 font-mono text-[12px]"
              value={providers.ollama.baseUrl}
              onChange={(event) =>
                setProviders({
                  ollama: { ...providers.ollama, baseUrl: event.target.value },
                })
              }
            />
          </ProviderField>
          {providers.ollama.enabled && map[statusKey("ollama")]?.detail ? (
            <p
              role="status"
              className="text-[12px] break-words text-muted-foreground"
            >
              {map[statusKey("ollama")]?.detail}
            </p>
          ) : null}
        </div>
      </ProviderRow>

      <AcpAgentRows
        acp={providers.acp}
        phase={phase}
        statuses={map}
        onChange={setAcp}
        loaded={loaded}
        onRefresh={(id) => void refreshProviders(id)}
        refreshing={refreshing}
      />
      <ProviderRow
        id="mock"
        name="Mock"
        enabled={providers.mock.enabled}
        disabled={!loaded}
        onEnabledChange={(enabled) => setProviders({ mock: { enabled } })}
        status={
          <span className="text-[11.5px] text-muted-foreground">
            {providers.mock.enabled ? "Demo" : "Disabled"}
          </span>
        }
      />
      {phase === "unavailable" ? (
        <p
          role="status"
          className="px-4 py-3 text-[12px] text-muted-foreground"
        >
          Couldn&apos;t check provider status. Use refresh to try again.
        </p>
      ) : null}
    </SettingsSection>
  )
}
