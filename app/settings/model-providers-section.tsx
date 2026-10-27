"use client"

import * as React from "react"
import { Plus, RotateCw, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { ProviderLogo } from "@/components/provider-logo"
import { probeModelProvider } from "@/lib/api-client"
import {
  MODEL_PROVIDER_PRESETS,
  MODEL_PROVIDER_SLUG_RE,
  RESERVED_MODEL_PROVIDER_SLUGS,
} from "@/lib/model-providers/presets"
import type { ModelProviderEntry } from "@/lib/settings/schema"

import { SettingsRow, SettingsSection } from "./section"
import type { AppSettingsApi } from "./use-app-settings"

/**
 * OpenAI-compatible model sources: presets ship disabled and keyless, and
 * anyone can add a custom endpoint. This mirrors the ACP agent list's CRUD
 * idiom (`acp-agents.tsx`) — writes only ever go through `update`, and the
 * "Test" button is the one place that talks to the API directly.
 */

const PRESET_SLUGS = new Set(MODEL_PROVIDER_PRESETS.map((preset) => preset.slug))

export function ModelProvidersSection({
  settings,
  loaded,
  update,
  flush,
}: AppSettingsApi) {
  const entries = settings.modelProviders

  // Presets in their shipped order, then user-added slugs alphabetically —
  // same ordering `enabledModelSources` uses server-side, so the list reads
  // the same way here and in the model picker.
  const orderedSlugs = React.useMemo(() => {
    const presetOrder = MODEL_PROVIDER_PRESETS.map((preset) => preset.slug).filter(
      (slug) => slug in entries
    )
    const customSlugs = Object.keys(entries)
      .filter((slug) => !PRESET_SLUGS.has(slug))
      .sort((a, b) => a.localeCompare(b))
    return [...presetOrder, ...customSlugs]
  }, [entries])

  const patchEntry = React.useCallback(
    (slug: string, changes: Partial<ModelProviderEntry>) => {
      update((current) => {
        const entry = current.modelProviders[slug]
        if (!entry) return current
        return {
          ...current,
          modelProviders: {
            ...current.modelProviders,
            [slug]: { ...entry, ...changes },
          },
        }
      })
    },
    [update]
  )

  const removeEntry = React.useCallback(
    (slug: string) => {
      update((current) => {
        const next = { ...current.modelProviders }
        delete next[slug]
        return { ...current, modelProviders: next }
      })
    },
    [update]
  )

  const addEntry = React.useCallback(
    (slug: string, entry: ModelProviderEntry) => {
      update((current) => ({
        ...current,
        modelProviders: { ...current.modelProviders, [slug]: entry },
      }))
    },
    [update]
  )

  return (
    <SettingsSection
      id="models"
      title="Model providers"
      description="OpenAI-compatible endpoints that supply models to harnesses like pi and direct chat — this is where API keys live."
    >
      {loaded
        ? orderedSlugs.map((slug) => (
            <ModelProviderRow
              key={slug}
              slug={slug}
              entry={entries[slug]!}
              removable={!PRESET_SLUGS.has(slug)}
              onPatch={patchEntry}
              onRemove={removeEntry}
              onFlush={flush}
            />
          ))
        : null}

      <AddModelProviderRow existing={entries} onAdd={addEntry} />
    </SettingsSection>
  )
}

type ModelProviderRowProps = {
  slug: string
  entry: ModelProviderEntry
  removable: boolean
  onPatch: (slug: string, changes: Partial<ModelProviderEntry>) => void
  onRemove: (slug: string) => void
  onFlush: () => Promise<void>
}

function ModelProviderRow({
  slug,
  entry,
  removable,
  onPatch,
  onRemove,
  onFlush,
}: ModelProviderRowProps) {
  const [probing, setProbing] = React.useState(false)
  const [result, setResult] = React.useState<
    { ok: boolean; count?: number; error?: string } | null
  >(null)
  const inputId = `model-provider-${slug}`
  // A comma-separated list over a string[]: held raw while typing so the
  // separator being typed is not swallowed, committed when the field is left.
  const [modelsDraft, setModelsDraft] = React.useState<string | null>(null)

  // Bound per row so the memoized inputs below never see a fresh closure.
  const patch = React.useCallback(
    (changes: Partial<ModelProviderEntry>) => onPatch(slug, changes),
    [slug, onPatch]
  )

  const commitModels = React.useCallback(() => {
    if (modelsDraft === null) return
    patch({ models: parseModelIds(modelsDraft) })
    setModelsDraft(null)
  }, [modelsDraft, patch])

  const test = React.useCallback(async () => {
    setProbing(true)
    setResult(null)
    try {
      // The route reads settings.json, so a base URL or key typed a moment ago
      // has to be on disk before the probe — otherwise this tests the old one.
      await onFlush()
      const outcome = await probeModelProvider(slug)
      setResult(outcome)
    } catch (err) {
      setResult({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to reach provider",
      })
    } finally {
      setProbing(false)
    }
  }, [slug, onFlush])

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <ProviderLogo slug={slug} className="size-4" />
          {entry.name || slug}
        </span>
      }
      htmlFor={inputId}
      control={
        <Switch
          id={inputId}
          checked={entry.enabled}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
      }
    >
      <div className="grid gap-2">
        <div className="flex items-center gap-2">
          <Input
            aria-label={`${entry.name || slug} base URL`}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://api.example.com/v1"
            className="h-8 font-mono text-[12px]"
            value={entry.baseUrl}
            onChange={(event) => patch({ baseUrl: event.target.value })}
          />
          {removable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Remove ${entry.name || slug}`}
              onClick={() => onRemove(slug)}
              className="shrink-0"
            >
              <Trash2 />
            </Button>
          ) : null}
        </div>
        <Input
          aria-label={`${entry.name || slug} API key`}
          type="password"
          spellCheck={false}
          autoComplete="off"
          placeholder="API key"
          className="h-8 font-mono text-[12px]"
          value={entry.apiKey}
          onChange={(event) => patch({ apiKey: event.target.value })}
        />
        <Input
          aria-label={`${entry.name || slug} model ids`}
          spellCheck={false}
          autoComplete="off"
          placeholder="Model ids, comma separated — empty lists them from /models"
          className="h-8 font-mono text-[12px]"
          value={modelsDraft ?? entry.models.join(", ")}
          onChange={(event) => setModelsDraft(event.target.value)}
          onBlur={commitModels}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur()
          }}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={probing || !entry.baseUrl}
            onClick={() => void test()}
            className="h-7 shrink-0 text-[12px]"
          >
            <RotateCw className={probing ? "animate-spin" : undefined} />
            Test
          </Button>
          {result ? (
            <p
              className={
                result.ok
                  ? "text-[12px] text-muted-foreground"
                  : "text-[12px] text-destructive"
              }
            >
              {result.ok ? `${result.count} models` : result.error}
            </p>
          ) : null}
        </div>
      </div>
    </SettingsRow>
  )
}

function AddModelProviderRow({
  existing,
  onAdd,
}: {
  existing: Record<string, ModelProviderEntry>
  onAdd: (slug: string, entry: ModelProviderEntry) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [slug, setSlug] = React.useState("")
  const [name, setName] = React.useState("")
  const [baseUrl, setBaseUrl] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [models, setModels] = React.useState("")

  const reset = React.useCallback(() => {
    setOpen(false)
    setSlug("")
    setName("")
    setBaseUrl("")
    setApiKey("")
    setModels("")
  }, [])

  const submit = React.useCallback(() => {
    // The slug defaults to the name, slugged — "LiteLLM" → `litellm`.
    const normalizedSlug = (slug.trim() || slugFromName(name)).toLowerCase()
    if (!MODEL_PROVIDER_SLUG_RE.test(normalizedSlug)) {
      toast.error("Slug must be lowercase letters, digits or hyphens (1-32 chars).")
      return
    }
    if (RESERVED_MODEL_PROVIDER_SLUGS.includes(normalizedSlug)) {
      toast.error(`"${normalizedSlug}" is reserved.`)
      return
    }
    if (normalizedSlug in existing) {
      toast.error(`A provider with slug "${normalizedSlug}" already exists.`)
      return
    }
    const trimmedName = name.trim() || normalizedSlug
    const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, "")
    if (!/^https?:\/\/\S+$/i.test(trimmedBaseUrl)) {
      toast.error("Base URL must start with http:// or https:// — e.g. http://localhost:4000/v1")
      return
    }
    // Added switched on: a provider someone just typed a URL for is one they
    // mean to use, and a disabled one supplies no models anywhere.
    onAdd(normalizedSlug, {
      enabled: true,
      name: trimmedName,
      baseUrl: trimmedBaseUrl,
      apiKey: apiKey.trim(),
      models: parseModelIds(models),
    })
    reset()
  }, [slug, name, baseUrl, apiKey, models, existing, onAdd, reset])

  if (!open) {
    return (
      <SettingsRow
        title="Add custom provider"
        description="Any OpenAI-compatible endpoint not covered by the presets above."
        control={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen(true)}
            className="text-[12.5px]"
          >
            <Plus />
            Add
          </Button>
        }
      />
    )
  }

  return (
    <SettingsRow
      title="Add custom provider"
      description="Any OpenAI-compatible endpoint — LiteLLM, vLLM, LM Studio, a gateway. The slug becomes the model id prefix, e.g. litellm/gpt-4o."
    >
      <div className="grid gap-2.5">
        <AddField label="Name" htmlFor="add-provider-name">
          <Input
            id="add-provider-name"
            spellCheck={false}
            autoComplete="off"
            placeholder="LiteLLM"
            className="h-8 text-[12.5px]"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </AddField>
        <AddField label="Slug" htmlFor="add-provider-slug">
          <Input
            id="add-provider-slug"
            spellCheck={false}
            autoComplete="off"
            placeholder={slugFromName(name) || "litellm"}
            className="h-8 font-mono text-[12px]"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
        </AddField>
        <AddField label="Base URL" htmlFor="add-provider-url">
          <Input
            id="add-provider-url"
            aria-label="Provider base URL"
            spellCheck={false}
            autoComplete="off"
            placeholder="http://localhost:4000/v1"
            className="h-8 font-mono text-[12px]"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </AddField>
        <AddField label="API key" htmlFor="add-provider-key">
          <Input
            id="add-provider-key"
            type="password"
            spellCheck={false}
            autoComplete="off"
            placeholder="Optional — e.g. your LiteLLM master or virtual key"
            className="h-8 font-mono text-[12px]"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </AddField>
        <AddField label="Models" htmlFor="add-provider-models">
          <Input
            id="add-provider-models"
            spellCheck={false}
            autoComplete="off"
            placeholder="Optional, comma separated — empty lists them from /models"
            className="h-8 font-mono text-[12px]"
            value={models}
            onChange={(event) => setModels(event.target.value)}
          />
        </AddField>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!(slug.trim() || slugFromName(name)) || !baseUrl.trim()}
            onClick={submit}
            className="text-[12.5px]"
          >
            Add provider
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={reset}
            className="text-[12.5px]"
          >
            Cancel
          </Button>
        </div>
      </div>
    </SettingsRow>
  )
}

function AddField({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[6rem_1fr] sm:items-center sm:gap-3">
      <label htmlFor={htmlFor} className="text-[12px] text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  )
}

/** "My LiteLLM" → `my-litellm`, within the slug alphabet and length. */
function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
}

function parseModelIds(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((id) => id.trim()).filter(Boolean))]
}
