import { FlaskConical, MessageSquare, type LucideIcon } from "lucide-react"
import * as React from "react"

import {
  BRAND_COLOR_MARKS,
  BRAND_MARKS,
  type BrandMarkNode,
} from "@/components/brand-marks"
import { harnessBrand, modelBrand, sourceBrand } from "@/lib/model-brand"
import { cn } from "@/lib/utils"

/**
 * Brand marks for models, model providers and harnesses, keyed by slug. The
 * path data is `components/brand-marks.ts` (generated from lobe-icons by
 * `scripts/import-brand-marks.mjs`); which id gets which slug is
 * `lib/model-brand.ts`. A brand is drawn in its own colours where it has
 * them and in `currentColor` where it is black-and-white. Two app-own backends
 * have no brand, so they get a lucide icon rather than an empty box.
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
  // Gradient ids are document-global: two instances sharing one would paint
  // from whichever came first, and from nothing once that one is hidden.
  const id = React.useId().replace(/[^a-zA-Z0-9_-]/g, "")
  const color = BRAND_COLOR_MARKS[slug]
  if (color) {
    return (
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        data-brand={slug}
        className={cn("size-4 shrink-0", className)}
      >
        {renderMark(color, `${id}-`, "0")}
      </svg>
    )
  }

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

/**
 * One node of a colour mark as an element, `__ID__` swapped for this
 * instance's prefix wherever it appears (an `id`, a `url(#…)`).
 */
function renderMark(
  [tag, props, ...children]: BrandMarkNode,
  prefix: string,
  key: string
): React.ReactElement {
  const own: Record<string, string> = { key }
  for (const [name, value] of Object.entries(props)) {
    own[name] = value.includes("__ID__") ? value.replaceAll("__ID__", prefix) : value
  }
  return React.createElement(
    tag,
    own,
    ...children.map((child, index) => renderMark(child, prefix, String(index)))
  )
}

/** True when a mark exists for the slug. */
export function hasProviderLogo(slug: string): boolean {
  return slug in BRAND_COLOR_MARKS || slug in BRAND_MARKS || slug in LUCIDE_FALLBACKS
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

/**
 * "[harness] Claude Code · sonnet" — what answered in a chat, as one run of
 * inline text so the row's own `truncate` still ends it with an ellipsis. Only
 * the harness carries a mark: a second one per row is more ink than the
 * sidebar's second line can hold, and the model is already named.
 */
export const AgentLabel = React.memo(function AgentLabel({
  providerId,
  providerName,
  modelName,
}: {
  providerId: string
  providerName: string
  modelName?: string
}) {
  const harness = harnessBrand(providerId, providerName)
  return (
    <span data-slot="agent-label">
      {harness ? (
        <ProviderLogo slug={harness} className="mr-1 inline size-3 align-[-2px]" />
      ) : null}
      {providerName}
      {modelName ? ` · ${modelName}` : null}
    </span>
  )
})
