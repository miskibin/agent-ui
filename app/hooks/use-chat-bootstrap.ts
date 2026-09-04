"use client"

import * as React from "react"
import { toast } from "sonner"

import * as api from "@/lib/api-client"
import type { ProviderInfo } from "@/lib/providers/types"
import type { AppSettings } from "@/lib/settings/schema"
import type { SessionMeta } from "@/lib/store/types"
import { CACHE_ACTIVE_KEY, readCache } from "@/lib/ui-cache"

import type { LoadThread } from "./use-threads"

/**
 * First paint, then first fetch.
 *
 * The three requests go out together and are read in one place because the
 * order they are applied in matters: the settings decide which harness the
 * providers fall back to, and the chat being reopened adopts its *own* agent
 * over that fallback — so it has to be applied last.
 */
export function useChatBootstrap({
  seedFromCache,
  hydrateConfig,
  hydrateSessions,
  adoptAgent,
  setSessionsLoaded,
  loadThread,
}: {
  seedFromCache: (
    cachedActive: string | null,
    onSeeded: (session: SessionMeta | undefined) => void
  ) => void
  hydrateConfig: (loaded: {
    settings?: AppSettings
    providers?: ProviderInfo[]
  }) => { providers: ProviderInfo[]; fallback: string }
  hydrateSessions: (
    list: SessionMeta[],
    cachedActive: string | null,
    onRestored: (session: SessionMeta | undefined, restored: string) => void
  ) => void
  adoptAgent: (
    session: SessionMeta | undefined,
    list: ProviderInfo[],
    fallback?: string
  ) => void
  setSessionsLoaded: (loaded: boolean) => void
  loadThread: LoadThread
}) {
  React.useEffect(() => {
    let cancelled = false

    // Paint the last known sidebar before the network answers. Deferred to a
    // microtask (runs before the browser paints) so the effect body itself
    // stays setState-free for the strict react-hooks rules.
    const cachedActive = readCache<string>(CACHE_ACTIVE_KEY)
    queueMicrotask(() => {
      if (cancelled) return
      seedFromCache(cachedActive, (session) => adoptAgent(session, []))
    })

    void (async () => {
      const [settingsResult, providersResult, sessionsResult] =
        await Promise.allSettled([
          api.fetchSettings(),
          api.fetchProviders(),
          api.fetchSessions(),
        ])
      if (cancelled) return

      const { providers: providerList, fallback: fallbackProvider } =
        hydrateConfig({
          settings:
            settingsResult.status === "fulfilled"
              ? settingsResult.value
              : undefined,
          providers:
            providersResult.status === "fulfilled"
              ? providersResult.value
              : undefined,
        })
      if (providersResult.status === "rejected") {
        toast.error("Could not load providers")
      }

      setSessionsLoaded(true)
      if (sessionsResult.status === "fulfilled") {
        hydrateSessions(sessionsResult.value, cachedActive, (session, restored) => {
          // Last, so the reopened chat's own agent wins over the settings default.
          adoptAgent(session, providerList, fallbackProvider)
          if (restored) void loadThread(restored)
        })
      } else {
        toast.error("Could not load your chats")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    adoptAgent,
    hydrateConfig,
    hydrateSessions,
    loadThread,
    seedFromCache,
    setSessionsLoaded,
  ])
}
