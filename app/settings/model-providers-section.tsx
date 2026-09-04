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

  // Bound per row so the memoized inputs below never see a fresh closure.
  const patch = React.useCallback(
    (changes: Partial<ModelProviderEntry>) => onPatch(slug, changes),
    [slug, onPatch]
  )

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

  const reset = React.useCallback(() => {
    setOpen(false)
    setSlug("")
    setName("")
    setBaseUrl("")
  }, [])

  const submit = React.useCallback(() => {
    const normalizedSlug = slug.trim().toLowerCase()
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
    onAdd(normalizedSlug, {
      enabled: false,
      name: trimmedName,
      baseUrl: trimmedBaseUrl,
      apiKey: "",
      models: [],
    })
    reset()
  }, [slug, name, baseUrl, existing, onAdd, reset])

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
      description="Slug becomes the model id prefix, e.g. my-provider/gpt-4."
    >
      <div className="grid gap-2">
        <Input
          aria-label="Provider slug"
          spellCheck={false}
          autoComplete="off"
          placeholder="Slug, e.g. my-provider"
          className="h-8 font-mono text-[12px]"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
        />
        <Input
          aria-label="Provider display name"
          spellCheck={false}
          autoComplete="off"
          placeholder="Display name"
          className="h-8 text-[12.5px]"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          aria-label="Provider base URL"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://api.example.com/v1"
          className="h-8 font-mono text-[12px]"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!slug.trim()}
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
