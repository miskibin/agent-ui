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
 * Restore the index and transcript independently of provider probes. Once
 * configuration arrives, the currently open chat adopts its own agent over
 * the settings fallback.
 */
export function useChatBootstrap({
  seedFromCache,
  hydrateConfig,
  hydrateSessions,
  adoptAgent,
  setSessionsLoaded,
  loadThread,
  activeIdRef,
  sessionsRef,
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
  activeIdRef: React.RefObject<string>
  sessionsRef: React.RefObject<SessionMeta[]>
}) {
  React.useEffect(() => {
    let cancelled = false

    // Paint the last known sidebar before the network answers. Deferred to a
    // microtask (runs before the browser paints) so the effect body itself
    // stays setState-free for the strict react-hooks rules.
    const cachedActive = readCache<string>(CACHE_ACTIVE_KEY)
    queueMicrotask(() => {
      if (cancelled) return
      seedFromCache(cachedActive, (session) => {
        adoptAgent(session, [])
        if (session) void loadThread(session.id)
      })
    })

    void (async () => {
      const config = Promise.allSettled([api.fetchSettings(), api.fetchProviders()])
      const sessionsResult = await Promise.allSettled([api.fetchSessions()]).then(([result]) => result)
      if (cancelled) return

      let restoredSession: SessionMeta | undefined
      let restoredId = ""
      setSessionsLoaded(true)
      if (sessionsResult.status === "fulfilled") {
        hydrateSessions(sessionsResult.value, cachedActive, (session, restored) => {
          restoredSession = session
          restoredId = restored
          adoptAgent(session, [])
          if (restored) void loadThread(restored)
        })
      } else {
        toast.error("Could not load your chats")
      }

      const [settingsResult, providersResult] = await config
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

      // The user may have navigated while the providers were being probed.
      const currentId = activeIdRef.current || restoredId
      const current = sessionsRef.current.find((session) => session.id === currentId)
        ?? (currentId === restoredId ? restoredSession : undefined)
      adoptAgent(current, providerList, fallbackProvider)
    })()

    return () => {
      cancelled = true
    }
  }, [
    adoptAgent,
    activeIdRef,
    hydrateConfig,
    hydrateSessions,
    loadThread,
    seedFromCache,
    sessionsRef,
    setSessionsLoaded,
  ])
}
