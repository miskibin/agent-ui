"use client"

import * as React from "react"
import { Check, Monitor, Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { Slider } from "@/components/ui/slider"
import type { ThemeMode } from "@/lib/settings/schema"
import { MAX_RADIUS, MIN_RADIUS } from "@/lib/theme/apply"
import { THEME_PRESETS, type ThemePreset } from "@/lib/theme/presets"
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

function PresetCard({
  preset,
  scheme,
  selected,
  onSelect,
}: {
  preset: ThemePreset
  scheme: "light" | "dark"
  selected: boolean
  onSelect: () => void
}) {
  const tokens = preset[scheme]
  const swatches = preset.swatches[scheme]

  return (
    <button
      type="button"
      data-slot="theme-preset"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "group flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors outline-none",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected
          ? "border-ring ring-2 ring-ring/40"
          : "hover:border-foreground/20"
      )}
    >
      <span
        aria-hidden
        className="flex h-11 items-center gap-1.5 rounded-md border px-2.5"
        style={{ backgroundColor: tokens.background, borderColor: tokens.border }}
      >
        {swatches.map((color, index) => (
          <span
            key={index}
            className="size-4 rounded-full"
            style={{ backgroundColor: color }}
          />
        ))}
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
      </span>
    </button>
  )
}

export function AppearanceSection() {
  const { appearance, setAppearance } = useAppearance()
  const { resolvedTheme } = useTheme()
  const hydrated = useHydrated()
  const scheme = hydrated && resolvedTheme === "dark" ? "dark" : "light"
  const radius = roundRadius(appearance.radius)

  return (
    <SettingsSection
      id="appearance"
      title="Appearance"
      description="Applies instantly and is saved to settings.json."
    >
      <SettingsRow
        title="Theme"
        description="Palettes are hand-tuned for light and dark separately."
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {THEME_PRESETS.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              scheme={scheme}
              selected={preset.id === appearance.theme}
              onSelect={() => setAppearance({ theme: preset.id })}
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
        title="Radius"
        description="Corner rounding for every surface in the app."
        control={
          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {radius}rem
          </span>
        }
      >
        <div className="flex items-center gap-4">
          <Slider
            aria-label="Corner radius"
            className="max-w-xs"
            min={MIN_RADIUS}
            max={MAX_RADIUS}
            step={0.025}
            value={[radius]}
            onValueChange={([next]) =>
              setAppearance({ radius: roundRadius(next) })
            }
          />
          <span aria-hidden className="flex items-center gap-1.5">
            <span className="size-6 rounded-sm border bg-muted" />
            <span className="size-6 rounded-md border bg-muted" />
            <span className="size-6 rounded-lg border bg-muted" />
            <span className="size-6 rounded-xl border bg-muted" />
          </span>
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}
