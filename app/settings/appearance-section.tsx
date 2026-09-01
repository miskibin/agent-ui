"use client"

import * as React from "react"
import { Check, Monitor, Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import type { ThemeMode } from "@/lib/settings/schema"
import { MAX_RADIUS, MIN_RADIUS } from "@/lib/theme/apply"
import {
  THEME_PRESETS,
  presetFontName,
  presetRadius,
  presetVars,
  type ThemePreset,
  type ThemeScheme,
} from "@/lib/theme/presets"
import { useAppearance } from "@/lib/theme/theme-client"
import { cn } from "@/lib/utils"

import { SettingsRow, SettingsSection } from "./section"

const MODE_OPTIONS: { id: ThemeMode; label: string; icon: typeof Sun }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
]

const subscribe = () => () => {}

/** True only after hydration — keeps preset previews off the server snapshot. */
function useHydrated() {
  return React.useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
}

function roundRadius(value: number) {
  return Math.round(value * 1000) / 1000
}

/**
 * A miniature of the theme itself: the card paints in the preset's own
 * background, border, radius and UI font, with the three colors that carry the
 * app — primary, accent, muted — as chips. Nothing here is hand-authored per
 * theme; every value is read straight from the registry item.
 */
function PresetCard({
  preset,
  scheme,
  selected,
  onSelect,
}: {
  preset: ThemePreset
  scheme: ThemeScheme
  selected: boolean
  onSelect: () => void
}) {
  const vars = presetVars(preset, scheme)
  const radius = presetRadius(preset)

  return (
    <button
      type="button"
      data-slot="theme-preset"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "group flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors outline-none",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected ? "border-ring ring-2 ring-ring/40" : "hover:border-foreground/20"
      )}
    >
      <span
        aria-hidden
        className="flex h-14 flex-col justify-between overflow-hidden border p-2"
        style={{
          backgroundColor: vars.background,
          borderColor: vars.border,
          borderRadius: `calc(${radius} * 1.4)`,
          color: vars.foreground,
        }}
      >
        <span
          className="text-[11px] leading-none font-medium"
          style={{ fontFamily: vars["font-sans"], letterSpacing: vars["letter-spacing"] }}
        >
          Aa
        </span>
        <span className="flex items-center gap-1">
          {[vars.primary, vars.accent, vars.muted, vars["muted-foreground"]].map(
            (color, index) => (
              <span
                key={index}
                className="h-3.5 flex-1"
                style={{ backgroundColor: color, borderRadius: radius }}
              />
            )
          )}
        </span>
      </span>
      <span className="flex flex-col gap-0.5 px-0.5 pb-0.5">
        <span className="flex items-center gap-1">
          <span className="text-[12.5px] font-medium text-foreground">
            {preset.name}
          </span>
          {selected ? <Check className="size-3 text-primary" /> : null}
        </span>
        <span className="text-[11px] leading-snug text-muted-foreground">
          {preset.description}
        </span>
        <span className="text-[10.5px] text-muted-foreground/80">
          {presetFontName(preset)} · {presetRadius(preset)}
        </span>
      </span>
    </button>
  )
}

export function AppearanceSection() {
  const { appearance, setAppearance } = useAppearance()
  const { resolvedTheme } = useTheme()
  const hydrated = useHydrated()
  const scheme: ThemeScheme =
    hydrated && resolvedTheme === "dark" ? "dark" : "light"

  const preset = THEME_PRESETS.find((item) => item.id === appearance.theme)
  const themeRadius = preset ? presetRadius(preset) : "0.5rem"
  const custom = appearance.radiusOverride !== null
  const radius = roundRadius(
    appearance.radiusOverride ?? (parseFloat(themeRadius) || 0.5)
  )

  return (
    <SettingsSection
      id="appearance"
      title="Appearance"
      description="Applies instantly and is saved to settings.json."
    >
      <SettingsRow
        title="Theme"
        description="Complete shadcn themes from the tweakcn registry — colors, fonts, radius and shadows, tuned separately for light and dark."
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {THEME_PRESETS.map((item) => (
            <PresetCard
              key={item.id}
              preset={item}
              scheme={scheme}
              selected={item.id === appearance.theme}
              onSelect={() => setAppearance({ theme: item.id })}
            />
          ))}
        </div>
      </SettingsRow>

      <SettingsRow
        title="Mode"
        description="System follows your OS setting."
        control={
          <div
            role="radiogroup"
            aria-label="Color mode"
            className="inline-flex h-8 items-center rounded-lg bg-muted p-[3px]"
          >
            {MODE_OPTIONS.map(({ id, label, icon: Icon }) => {
              const active = appearance.mode === id
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setAppearance({ mode: id })}
                  className={cn(
                    "inline-flex h-full items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors outline-none",
                    "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    active
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              )
            })}
          </div>
        }
      />

      <SettingsRow
        title="Custom radius"
        description={
          custom
            ? "Corner rounding for every surface in the app."
            : `Following the theme — ${themeRadius}.`
        }
        control={
          <span className="flex items-center gap-3">
            {custom ? (
              <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
                {radius}rem
              </span>
            ) : null}
            <Switch
              aria-label="Override the theme radius"
              checked={custom}
              onCheckedChange={(next) =>
                setAppearance({ radiusOverride: next ? radius : null })
              }
            />
          </span>
        }
      >
        {custom ? (
          <div className="flex items-center gap-4">
            <Slider
              aria-label="Corner radius"
              className="max-w-xs"
              min={MIN_RADIUS}
              max={MAX_RADIUS}
              step={0.025}
              value={[radius]}
              onValueChange={([next]) =>
                setAppearance({ radiusOverride: roundRadius(next) })
              }
            />
            <span aria-hidden className="flex items-center gap-1.5">
              <span className="size-6 rounded-sm border bg-muted" />
              <span className="size-6 rounded-md border bg-muted" />
              <span className="size-6 rounded-lg border bg-muted" />
              <span className="size-6 rounded-xl border bg-muted" />
            </span>
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  )
}
