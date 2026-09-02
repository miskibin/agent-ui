"use client"

import * as React from "react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import * as api from "@/lib/api-client"
import type { AppSettings } from "@/lib/settings/schema"

import { SettingsRow, SettingsSection } from "./section"
import type { AppSettingsApi } from "./use-app-settings"

/** The "first one found" choice, kept out of the stored ids' namespace. */
const AUTO = "__auto__"

/**
 * Where "Open in editor" and "Open in terminal" go. The choices are whatever
 * the server found installed, asked for once when the section mounts; a
 * machine with nothing detected says so instead of offering an empty menu.
 */
export function EditorSection({ settings, loaded, update }: AppSettingsApi) {
  const [targets, setTargets] = React.useState<api.OpenTargets | null>(null)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    api
      .fetchOpenTargets()
      .then((found) => {
        if (!cancelled) setTargets(found)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setEditor = React.useCallback(
    (patch: Partial<AppSettings["editor"]>) =>
      update((current) => ({
        ...current,
        editor: { ...current.editor, ...patch },
      })),
    [update]
  )

  const ready = loaded && (targets !== null || failed)

  return (
    <SettingsSection
      id="editor"
      title="Editor & terminal"
      description="Where files and folders open from a chat — the right-click menu on a changed file, the file panel, and ⌘O."
    >
      <SettingsRow
        title="Default editor"
        description={
          targets && targets.editors.length === 0
            ? "No editor was found on this machine. VS Code, Cursor, Zed, Windsurf, Sublime Text and the JetBrains IDEs are detected when their command-line tool is on PATH."
            : "Used by “Open in editor”. The menu still lists every editor found."
        }
        control={
          ready ? (
            <TargetSelect
              value={settings.editor.defaultEditor}
              options={targets?.editors ?? []}
              onChange={(defaultEditor) => setEditor({ defaultEditor })}
              autoLabel="First found"
            />
          ) : (
            <Skeleton className="h-8 w-44" />
          )
        }
      />
      <SettingsRow
        title="Terminal"
        description={
          targets && targets.terminals.length === 0
            ? "No terminal was found on this machine."
            : "Used by “Open in terminal”, which starts in the chat's folder."
        }
        control={
          ready ? (
            <TargetSelect
              value={settings.editor.terminal}
              options={targets?.terminals ?? []}
              onChange={(terminal) => setEditor({ terminal })}
              autoLabel="System default"
            />
          ) : (
            <Skeleton className="h-8 w-44" />
          )
        }
      />
    </SettingsSection>
  )
}

function TargetSelect({
  value,
  options,
  onChange,
  autoLabel,
}: {
  value: string
  options: api.OpenTarget[]
  onChange: (id: string) => void
  autoLabel: string
}) {
  // A stored id whose program has since gone is still shown, so the setting
  // reads as what it is rather than silently snapping back to "auto".
  const known = options.some((option) => option.id === value)
  return (
    <Select
      value={value || AUTO}
      onValueChange={(next) => onChange(next === AUTO ? "" : next)}
      disabled={options.length === 0}
    >
      <SelectTrigger size="sm" className="w-44 text-[12.5px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTO}>{autoLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
        {value && !known ? (
          <SelectItem value={value}>{value} (not found)</SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  )
}
