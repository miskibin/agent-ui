"use client"

import * as React from "react"
import { toast } from "sonner"

import { ProviderLogo } from "@/components/provider-logo"
import type { ModelOption, ModelPickerGroup } from "@/components/ui/model-picker"
import * as api from "@/lib/api-client"
import { errorMessage, pickProvider } from "@/lib/chat-helpers"
import { joinModelId } from "@/lib/model-providers/ids"
import type {
  PermissionMode,
  ProviderCapabilities,
  ProviderInfo,
} from "@/lib/providers/types"
import type { AppSettings } from "@/lib/settings/schema"
import type { SessionMeta } from "@/lib/store/types"

import { EMPTY_PERMISSION_MODES } from "./chat-types"
import type { ChatRefs } from "./use-chat-refs"

/**
 * What the composer shows when the harness reports no default of its own.
 * Display only — see `effectivePermission`.
 */
const FALLBACK_PERMISSION_MODE: PermissionMode = "full"

export type AgentConfig = ReturnType<typeof useAgentConfig>

/**
 * What the next turn will be run with: the saved settings, the harnesses this
 * machine can reach, the model catalog behind the active one, and the effort
 * and permission picked for it — plus the writing-back that makes a chat
 * remember its own agent.
 */
export function useAgentConfig({
  refs,
  patchLocal,
}: {
  refs: ChatRefs
  patchLocal: (id: string, patch: Partial<SessionMeta>) => void
}) {
  const { activeIdRef, modelRef } = refs

  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  const [providers, setProviders] = React.useState<ProviderInfo[]>([])
  const [providerId, setProviderId] = React.useState("")
  const [models, setModels] = React.useState<ModelOption[]>([])
  /**
   * Picker sections for the active provider, in order — empty for a provider
   * that serves models from a single source.
   */
  const [modelGroups, setModelGroups] = React.useState<
    Array<{ id: string; label: string }>
  >([])
  const [capabilities, setCapabilities] =
    React.useState<ProviderCapabilities | null>(null)
  /** Model ids the active provider says take image input — empty until it says otherwise. */
  const [visionModels, setVisionModels] = React.useState<string[]>([])
  const [model, setModel] = React.useState("")
  const [effort, setEffort] = React.useState("")
  /**
   * The open chat's stored permission pick, or "" for "never chosen". The mode
   * a turn actually runs under is derived from this and the harness's own list
   * (`chosenPermission` below), so a provider switch cannot leave the
   * composer showing a mode the new harness does not offer.
   */
  const [permissionMode, setPermissionMode] = React.useState("")

  /**
   * The provider the user just picked, until its model list lands. Only that
   * pick may rewrite the chat's stored model — the same resolution running for
   * a chat that was merely opened must leave the chat's own agent alone.
   */
  const providerPickRef = React.useRef("")

  /** The modes the active harness can enforce; empty = it offers no choice. */
  const permissionModes =
    capabilities?.permissionModes ?? EMPTY_PERMISSION_MODES
  /**
   * The mode this chat's turns are *sent* under — an explicit pick, and only
   * that. `""` (nothing chosen, or a pick this harness does not offer) keeps
   * the field out of the request entirely, which every provider already reads
   * as "whatever settings say". Synthesizing a default here would hand the
   * harness a policy the user never chose, widening both the ACP approval
   * policy and, for dsh, the sandbox its process is spawned into.
   */
  const chosenPermission: PermissionMode | "" = permissionModes.includes(
    permissionMode as PermissionMode
  )
    ? (permissionMode as PermissionMode)
    : ""
  /**
   * What the composer *displays*: the pick, else the policy the harness says
   * it already runs under. Display only — never sent.
   */
  const effectivePermission: PermissionMode | "" =
    chosenPermission ||
    (permissionModes.length === 0
      ? ""
      : (capabilities?.defaultPermissionMode ?? FALLBACK_PERMISSION_MODE))

  /**
   * Points the pickers at the agent a chat was last run with. The chat's own
   * provider wins over the settings default; an agent that is gone (or off)
   * falls back to whatever `fallback` resolved to, without rewriting what the
   * chat remembers.
   */
  const adoptAgent = React.useCallback(
    (session: SessionMeta | undefined, list: ProviderInfo[], fallback = "") => {
      const stored = session?.providerId ?? ""
      const usable = list.find((item) => item.id === stored)?.available
        ? stored
        : list.length === 0 && stored
          ? stored
          : fallback
      if (usable) setProviderId(usable)
      if (usable === stored && session?.model) setModel(session.model)
      // Unlike the model, this is cleared when the chat has no pick of its own:
      // the harness's default is derived, and a stale mode must not leak from
      // the chat being left behind into the one being opened.
      setPermissionMode(usable === stored ? (session?.permissionMode ?? "") : "")
    },
    []
  )

  /** Writes the picked agent onto the open chat, so reopening it restores it. */
  const persistAgent = React.useCallback(
    (patch: {
      providerId?: string
      model?: string
      permissionMode?: string
    }) => {
      const sessionId = activeIdRef.current
      if (!sessionId) return
      patchLocal(sessionId, patch)
      void api
        .patchSession(sessionId, patch)
        .catch((err: unknown) =>
          toast.error(errorMessage(err, "Could not save the chat's agent"))
        )
    },
    [activeIdRef, patchLocal]
  )

  const chooseProvider = React.useCallback(
    (id: string) => {
      setProviderId(id)
      // The model this provider resolves to is persisted once its list lands.
      providerPickRef.current = id
      persistAgent({ providerId: id })
    },
    [persistAgent]
  )

  const configureProvider = React.useCallback(
    async (id: string) => {
      try {
        const result = await api.configureProviderBinary(id)
        if ("cancelled" in result && result.cancelled) return
        if (!("path" in result)) return
        setProviders(result.providers)
        const next = result.providers.find((provider) => provider.id === id)
        if (next?.available) {
          setProviderId(id)
          providerPickRef.current = id
          persistAgent({ providerId: id })
          toast.success(`${next.name} is ready.`)
          return
        }
        toast.success(`Saved ${result.path}`)
        if (next?.unavailableReason) toast.message(next.unavailableReason)
      } catch (err: unknown) {
        toast.error(errorMessage(err, "Could not configure the harness"))
      }
    },
    [persistAgent]
  )

  const chooseModel = React.useCallback(
    (id: string) => {
      setModel(id)
      persistAgent({ model: id })
    },
    [persistAgent]
  )

  const choosePermission = React.useCallback(
    (mode: PermissionMode) => {
      setPermissionMode(mode)
      persistAgent({ permissionMode: mode })
    },
    [persistAgent]
  )

  /**
   * Bootstrap. Either half may be missing — that request failed — and the
   * caller is handed back the provider list and the fallback it resolved to,
   * because the chat being reopened adopts its own agent over that.
   */
  const hydrate = React.useCallback(
    (loaded: { settings?: AppSettings; providers?: ProviderInfo[] }) => {
      if (loaded.settings) {
        setSettings(loaded.settings)
        setEffort(loaded.settings.chat.defaultEffort)
      }
      let providerList: ProviderInfo[] = []
      let fallbackProvider = ""
      if (loaded.providers) {
        providerList = loaded.providers
        setProviders(providerList)
        fallbackProvider = pickProvider(
          providerList,
          loaded.settings?.providers.active ?? ""
        )
        setProviderId(fallbackProvider)
      }
      return { providers: providerList, fallback: fallbackProvider }
    },
    []
  )

  // Models follow the active provider; the current pick survives when it can.
  const defaultModel = settings?.chat.defaultModel ?? ""
  React.useEffect(() => {
    if (!providerId) return
    let cancelled = false
    api
      .fetchModels(providerId)
      .then((data) => {
        if (cancelled) return
        const groups = data.groups ?? []
        setModels(data.models)
        setModelGroups(groups)
        setCapabilities(data.capabilities ?? null)
        setVisionModels(data.visionModels ?? [])
        // A grouped catalog hands out composite `<source>/<model>` ids. A pick
        // stored before that — on the chat, or as the settings default — names
        // a bare Ollama model, so try its composite form before deciding the
        // model is gone and silently landing on the first of the list.
        const resolve = (id: string) => {
          if (!id) return ""
          if (data.models.some((m) => m.id === id)) return id
          if (groups.length === 0) return ""
          // A slash does not make an id composite: `hf.co/user/model` is a
          // legitimate Ollama tag, and its first segment names no source here.
          // Only a known group id means the id was already composite.
          const slash = id.indexOf("/")
          const source = slash > 0 ? id.slice(0, slash) : ""
          if (source && groups.some((group) => group.id === source)) return ""
          const composite = joinModelId("ollama", id)
          return data.models.some((m) => m.id === composite) ? composite : ""
        }
        const next =
          resolve(modelRef.current) ||
          resolve(defaultModel) ||
          (data.models[0]?.id ?? "")
        setModel(next)
        // Only a provider the user just picked writes back: opening a chat
        // resolves models too, and that must not overwrite its stored agent.
        if (providerPickRef.current === providerId) {
          providerPickRef.current = ""
          if (next) persistAgent({ model: next })
        }
        if (data.error) toast.error(data.error)
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(errorMessage(err, "Could not load models"))
      })
    return () => {
      cancelled = true
    }
  }, [providerId, defaultModel, persistAgent, modelRef])

  const providerName = React.useCallback(
    (id: string) => providers.find((item) => item.id === id)?.name ?? id,
    [providers]
  )

  const showEfforts =
    !!capabilities?.effort && (settings?.chat.defaultEffort ?? "") !== ""

  const activeProviderName = providers.find(
    (item) => item.id === providerId
  )?.name

  /**
   * Group headings carry the source's brand mark. Built once per catalog, not
   * per render: the composer memo would otherwise be rebuilt every frame of a
   * streaming turn.
   */
  const pickerGroups = React.useMemo<ModelPickerGroup[]>(
    () =>
      modelGroups.map((group) => ({
        ...group,
        icon: <ProviderLogo slug={group.id} className="size-3.5" />,
      })),
    [modelGroups]
  )

  /**
   * Settings can enable a backend or change a model source, and this hook read
   * both at boot — so the settings panel closing re-reads them. Unlike
   * `hydrate` it leaves the chat's chosen agent alone.
   */
  const refresh = React.useCallback(() => {
    void api
      .fetchSettings()
      .then(setSettings)
      .catch(() => {
        /* keep what we had */
      })
    void api
      .fetchProviders()
      .then(setProviders)
      .catch(() => {
        /* keep what we had */
      })
  }, [])

  return {
    settings,
    providers,
    providerId,
    models,
    capabilities,
    visionModels,
    model,
    effort,
    setEffort,
    permissionModes,
    chosenPermission,
    effectivePermission,
    adoptAgent,
    chooseProvider,
    configureProvider,
    chooseModel,
    choosePermission,
    hydrate,
    refresh,
    providerName,
    showEfforts,
    activeProviderName,
    pickerGroups,
  }
}
