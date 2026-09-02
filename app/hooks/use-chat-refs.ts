"use client"

import * as React from "react"

import type { ChatInputHandle } from "@/components/ui/chat-input"
import type { AppSettings } from "@/lib/settings/schema"
import type { ProviderInfo } from "@/lib/providers/types"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"

import type { QueuedMessage } from "./chat-types"

export type ChatRefs = ReturnType<typeof useChatRefs>

/**
 * The spine the whole page is built on: one place for the refs more than one
 * concern reads.
 *
 * They exist for a single reason — a click handler, a shortcut or a stream
 * callback must read the state the user is looking at *without* closing over
 * it, because a closure over state is a new function identity every render and
 * that is exactly what breaks the memoized message and sidebar rows. The
 * mirrors are written by `useMirrorRefs` in one effect after paint.
 *
 * A ref that only one concern touches is not here — it belongs in that hook.
 */
export function useChatRefs() {
  /* State mirrors, written after every paint. */
  const activeIdRef = React.useRef("")
  const threadsRef = React.useRef<Record<string, StoredMessage[]>>({})
  const sessionsRef = React.useRef<SessionMeta[]>([])
  const providersRef = React.useRef<ProviderInfo[]>([])
  const providerIdRef = React.useRef("")
  const modelRef = React.useRef("")
  /** Read by `runPrompt`, which must not re-create itself when settings land. */
  const settingsRef = React.useRef<AppSettings | null>(null)
  const queuesRef = React.useRef<Record<string, QueuedMessage[]>>({})

  /** One in-flight turn per chat; background chats keep streaming. */
  const abortsRef = React.useRef(new Map<string, AbortController>())
  const composerRef = React.useRef<ChatInputHandle>(null)
  /** Sidebar order, for ⌘⇧[ / ⌘⇧] and ⌘1…9. */
  const orderedIdsRef = React.useRef<string[]>([])
  /** Set once `send` exists; `runPrompt` is defined before it. */
  const drainQueueRef = React.useRef<(sessionId: string) => void>(() => {})
  const selectSessionRef = React.useRef<(id: string) => void>(() => {})

  return {
    activeIdRef,
    threadsRef,
    sessionsRef,
    providersRef,
    providerIdRef,
    modelRef,
    settingsRef,
    queuesRef,
    abortsRef,
    composerRef,
    orderedIdsRef,
    drainQueueRef,
    selectSessionRef,
  }
}

/**
 * Mirrors for the stable callbacks — they run after paint, so a click handler
 * always reads the state the user is looking at. One effect with no dependency
 * array, exactly as before: every render refreshes every mirror.
 */
export function useMirrorRefs(
  refs: ChatRefs,
  values: {
    threads: Record<string, StoredMessage[]>
    activeId: string
    sessions: SessionMeta[]
    providers: ProviderInfo[]
    providerId: string
    model: string
    settings: AppSettings | null
    queues: Record<string, QueuedMessage[]>
  }
) {
  const {
    threadsRef,
    activeIdRef,
    sessionsRef,
    providersRef,
    providerIdRef,
    modelRef,
    settingsRef,
    queuesRef,
  } = refs
  React.useEffect(() => {
    threadsRef.current = values.threads
    activeIdRef.current = values.activeId
    sessionsRef.current = values.sessions
    providersRef.current = values.providers
    providerIdRef.current = values.providerId
    modelRef.current = values.model
    settingsRef.current = values.settings
    queuesRef.current = values.queues
  })
}
