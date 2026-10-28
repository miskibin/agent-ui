import { FlaskConical, MessageSquare, type LucideIcon } from "lucide-react"
import * as React from "react"

import { BRAND_MARKS } from "@/components/brand-marks"
import { harnessBrand, modelBrand, sourceBrand } from "@/lib/model-brand"
import { cn } from "@/lib/utils"

/**
 * Brand marks for models, model providers and harnesses, keyed by slug. The
 * path data is `components/brand-marks.ts` (generated from lobe-icons by
 * `scripts/import-brand-marks.mjs`); which id gets which slug is
 * `lib/model-brand.ts`. Two app-own backends have no brand, so they get a
 * lucide icon rather than an empty box.
 */
const LUCIDE_FALLBACKS: Record<string, LucideIcon> = {
  chat: MessageSquare,
  mock: FlaskConical,
}

/** Brand mark for a slug; null when unknown (caller falls back to text). */
export function ProviderLogo({
  slug,
  className,
}: {
  slug: string
  className?: string
}): React.ReactElement | null {
  const paths = BRAND_MARKS[slug]
  if (paths) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
        aria-hidden="true"
        data-brand={slug}
        className={cn("size-4 shrink-0", className)}
      >
        {paths.map((path, index) =>
          typeof path === "string" ? (
            <path key={index} d={path} />
          ) : (
            <path key={index} d={path[0]} fillOpacity={path[1]} />
          )
        )}
      </svg>
    )
  }

  const LucideFallback = LUCIDE_FALLBACKS[slug]
  if (LucideFallback) {
    return (
      <LucideFallback aria-hidden="true" className={cn("size-4 shrink-0", className)} />
    )
  }

  return null
}

/** True when a mark exists for the slug. */
export function hasProviderLogo(slug: string): boolean {
  return slug in BRAND_MARKS || slug in LUCIDE_FALLBACKS
}

/** Mark for a model id — its family, else its source; null when neither has one. */
export function ModelLogo({
  model,
  source,
  className,
}: {
  model: string
  source?: string
  className?: string
}) {
  const slug = modelBrand(model, source)
  return slug ? <ProviderLogo slug={slug} className={className} /> : null
}

/** Mark for a model source (a `modelProviders` slug, `ollama`, …). */
export function SourceLogo({ source, className }: { source: string; className?: string }) {
  const slug = sourceBrand(source)
  return slug ? <ProviderLogo slug={slug} className={className} /> : null
}

/** Mark for a harness — a provider id, plus its name for configured ACP agents. */
export function HarnessLogo({
  providerId,
  name,
  className,
}: {
  providerId: string
  name?: string
  className?: string
}) {
  const slug = harnessBrand(providerId, name)
  return slug ? <ProviderLogo slug={slug} className={className} /> : null
}

const INLINE_MARK = "mr-1 inline size-3 align-[-2px] opacity-80"

/**
 * "[harness] Claude Code · [model] Sonnet 4.5" — what answered in a chat, as
 * one run of inline text so the row's own `truncate` still ends it with an
 * ellipsis. The model's mark is dropped when it would repeat the harness's.
 */
export const AgentLabel = React.memo(function AgentLabel({
  providerId,
  providerName,
  model,
  modelName,
}: {
  providerId: string
  providerName: string
  /** The stored model id — what the mark is resolved from. */
  model?: string
  /** What to call it; defaults to the id. */
  modelName?: string
}) {
  const harness = harnessBrand(providerId, providerName)
  const family = model ? modelBrand(model) : null
  return (
    <span data-slot="agent-label">
      {harness ? <ProviderLogo slug={harness} className={INLINE_MARK} /> : null}
      {providerName}
      {model ? (
        <>
          {" · "}
          {family && family !== harness ? (
            <ProviderLogo slug={family} className={INLINE_MARK} />
          ) : null}
          {modelName || model}
        </>
      ) : null}
    </span>
  )
})
