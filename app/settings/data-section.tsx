"use client"

import * as React from "react"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"

import { SettingsRow, SettingsSection } from "./section"
import type { AppSettingsApi } from "./use-app-settings"

const CONFIRM_TIMEOUT = 5000

export function DataSection({
  dataDir,
  settings,
  update,
  onSessionsCleared,
}: AppSettingsApi & { dataDir: string; onSessionsCleared?: () => void }) {
  const [armed, setArmed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), CONFIRM_TIMEOUT)
    return () => clearTimeout(timer)
  }, [armed])

  const clearChats = React.useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch("/api/sessions", { method: "DELETE" })
      if (res.status === 404 || res.status === 405) {
        toast.error("The sessions API isn't available yet.")
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      // The chat page behind the panel still holds the deleted index; without
      // this its sidebar stays stale and re-seeds from the cache on restart.
      onSessionsCleared?.()
      toast.success("All chats deleted.")
    } catch {
      toast.error("Couldn't delete chats.")
    } finally {
      setBusy(false)
      setArmed(false)
    }
  }, [onSessionsCleared])

  return (
    <SettingsSection
      id="data"
      title="Data"
      description="Everything lives on this machine, in plain files."
    >
      <SettingsRow
        title="Data directory"
        description="Settings, sessions and transcripts are written here."
      >
        <code className="block truncate rounded-md border bg-muted/50 px-2.5 py-1.5 font-mono text-[12px] text-muted-foreground">
          {dataDir}
        </code>
      </SettingsRow>

      <SettingsRow
        title="Local files"
        htmlFor="files-any-path"
        description="Show images an answer links by absolute path, from anywhere on this machine. Off limits it to the app's own folder, a chat's working folder, and the agent workspace."
        control={
          <Switch
            id="files-any-path"
            checked={settings.files.anyPath}
            onCheckedChange={(anyPath) =>
              update((current) => ({ ...current, files: { anyPath } }))
            }
          />
        }
      />

      <SettingsRow
        title="Clear all chats"
        description={
          armed
            ? "This permanently deletes every saved conversation."
            : "Deletes every saved conversation. This cannot be undone."
        }
        control={
          armed ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setArmed(false)}
                className="text-[12.5px]"
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => void clearChats()}
                className="text-[12.5px]"
              >
                <Trash2 />
                Delete everything
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setArmed(true)}
              className="text-[12.5px] text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 />
              Clear all chats
            </Button>
          )
        }
      />
    </SettingsSection>
  )
}
