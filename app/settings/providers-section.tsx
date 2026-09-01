"use client"

import * as React from "react"
import { RotateCw, TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
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
import type { AppSettings } from "@/lib/settings/schema"

import { SettingsRow, SettingsSection } from "./section"
import type { AppSettingsApi } from "./use-app-settings"

const PROVIDERS = [
  { id: "mock", label: "Mock" },
  { id: "ollama", label: "Ollama" },
  { id: "pi", label: "pi (Ollama)" },
  { id: "cursorAgent", label: "Cursor Agent" },
] as const

type ProviderStatus = { available: boolean; detail?: string }
type StatusPhase = "loading" | "ready" | "unavailable"
type StatusState = { phase: StatusPhase; map: Record<string, ProviderStatus> }

/** "cursor-agent", "cursorAgent" and "Cursor Agent" all collapse to one key. */
function statusKey(id: string) {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function readAvailable(value: unknown): ProviderStatus | null {
  if (typeof value === "boolean") return { available: value }
  if (!value || typeof value !== "object") return null
  const entry = value as Record<string, unknown>
  const flag =
    entry.available ?? entry.reachable ?? entry.ok ?? entry.installed ?? null
  const status = typeof entry.status === "string" ? entry.status : null
  const available =
    typeof flag === "boolean"
      ? flag
      : status
        ? ["ok", "ready", "available", "online", "reachable"].includes(
            status.toLowerCase()
          )
        : false
  const detail = [entry.detail, entry.error, entry.message, entry.version].find(
    (candidate) => typeof candidate === "string" && candidate.length > 0
  )
  return { available, detail: detail as string | undefined }
}

/**
 * `/api/providers` belongs to the agent runtime and its exact shape is still
 * settling, so this accepts an array, `{ providers: [...] }`, or an id-keyed
 * map, and treats anything it can't read as "status unknown".
 */
function parseStatus(data: unknown): Record<string, ProviderStatus> {
  const map: Record<string, ProviderStatus> = {}
  const container = (data ?? {}) as Record<string, unknown>
  const list = Array.isArray(data)
    ? data
    : Array.isArray(container.providers)
      ? (container.providers as unknown[])
      : null

  if (list) {
    for (const item of list) {
      if (!item || typeof item !== "object") continue
      const entry = item as Record<string, unknown>
      const id = entry.id ?? entry.name ?? entry.provider
      if (typeof id !== "string") continue
      const status = readAvailable(entry)
      if (status) map[statusKey(id)] = status
    }
    return map
  }

  for (const [id, value] of Object.entries(container)) {
    const status = readAvailable(value)
    if (status) map[statusKey(id)] = status
  }
  return map
}

function useProviderStatus() {
  const [state, setState] = React.useState<StatusState>({
    phase: "loading",
    map: {},
  })

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/providers", { cache: "no-store" })
      if (!res.ok) throw new Error(String(res.status))
      const map = parseStatus(await res.json())
      setState({ phase: "ready", map })
      return map
    } catch {
      setState({ phase: "unavailable", map: {} })
      return null
    }
  }, [])

  React.useEffect(() => {
    // Microtask defer keeps the effect body setState-free for the strict
    // react-hooks rules; the fetch itself is async anyway.
    queueMicrotask(() => void refresh())
  }, [refresh])

  return { ...state, refresh }
}

function StatusBadge({
  phase,
  status,
}: {
  phase: StatusPhase
  status: ProviderStatus | undefined
}) {
  if (phase === "loading") return <Skeleton className="h-5 w-20" />
  if (phase === "unavailable") return null
  const available = status?.available ?? false

  return (
    <Badge
      variant={available ? "secondary" : "outline"}
      title={status?.detail}
      className="gap-1.5 text-[11px] font-normal"
    >
      <span
        className={
          available
            ? "size-1.5 rounded-full bg-emerald-500"
            : "size-1.5 rounded-full bg-muted-foreground/50"
        }
      />
      {available ? "Reachable" : "Unreachable"}
    </Badge>
  )
}

export function ProvidersSection({ settings, loaded, update }: AppSettingsApi) {
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

  const testOllama = React.useCallback(async () => {
    setTesting(true)
    const next = await refresh()
    setTesting(false)
    if (!next) {
      toast.error("Provider status is unavailable.")
      return
    }
    const status = next[statusKey("ollama")]
    if (status?.available) toast.success("Ollama is reachable.")
    else toast.error(status?.detail ?? "Ollama did not respond.")
  }, [refresh])

  return (
    <SettingsSection
      id="providers"
      title="Providers"
      description="Which agent backends the composer can talk to."
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
                {PROVIDERS.map((provider) => (
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
        title="pi (Ollama)"
        htmlFor="provider-pi"
        description="Agentic harness: the pi CLI drives the models above with read, write, edit and bash tools."
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
