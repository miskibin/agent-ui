"use client"

import * as React from "react"

import { DEFAULT_MODEL_EFFORTS } from "@/components/ui/model-picker"
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

export function ChatSection({ settings, loaded, update }: AppSettingsApi) {
  const chat = settings.chat

  const setChat = React.useCallback(
    (patch: Partial<AppSettings["chat"]>) =>
      update((current) => ({ ...current, chat: { ...current.chat, ...patch } })),
    [update]
  )

  return (
    <SettingsSection
      id="chat"
      title="Chat"
      description="Defaults applied to every new conversation."
    >
      <SettingsRow
        title="Reasoning effort"
        description="Preselected in the composer's model picker."
        control={
          loaded ? (
            <Select
              value={chat.defaultEffort}
              onValueChange={(defaultEffort) => setChat({ defaultEffort })}
            >
              <SelectTrigger size="sm" className="w-40 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEFAULT_MODEL_EFFORTS.map((effort) => (
                  <SelectItem key={effort.id} value={effort.id}>
                    {effort.label}
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
        title="Prompt suggestions"
        htmlFor="chat-suggestions"
        description="Show starter prompts on an empty chat."
        control={
          <Switch
            id="chat-suggestions"
            checked={chat.showSuggestions}
            onCheckedChange={(showSuggestions) => setChat({ showSuggestions })}
          />
        }
      />

      <SettingsRow
        title="Automatic titles"
        htmlFor="chat-auto-title"
        description="Name a chat from its first message."
        control={
          <Switch
            id="chat-auto-title"
            checked={chat.autoTitle}
            onCheckedChange={(autoTitle) => setChat({ autoTitle })}
          />
        }
      />

      <SettingsRow
        title="Notification sounds"
        htmlFor="chat-notification-sounds"
        description="Play a sound when an agent finishes or asks a question."
        control={
          <Switch
            id="chat-notification-sounds"
            checked={chat.notificationSounds}
            onCheckedChange={(notificationSounds) =>
              setChat({ notificationSounds })
            }
          />
        }
      />

      <SettingsRow
        title="Desktop notifications"
        htmlFor="chat-desktop-notifications"
        description="Notify through the system when an agent finishes or asks a question while this window is in the background, and count waiting chats on the app icon."
        control={
          <Switch
            id="chat-desktop-notifications"
            checked={chat.desktopNotifications}
            onCheckedChange={(desktopNotifications) =>
              setChat({ desktopNotifications })
            }
          />
        }
      />
    </SettingsSection>
  )
}
