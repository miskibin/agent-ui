"use client"

import * as React from "react"

import type { SessionMeta, StoredMessage } from "@/lib/store/types"
import type { SubagentBusEvent, SubagentRunSummary } from "@/lib/subagents/types"

import type { ChatRefs } from "./use-chat-refs"
import type { LoadThread } from "./use-threads"
import type { RunPrompt } from "./use-turn-runner"

type ServerFrame = SubagentBusEvent | { type: "snapshot"; runs: SubagentRunSummary[] }

/**
 * Subagent runs, seen from the page: turns the *server* starts when an agent
 * in one chat hands work to another harness (`lib/subagents`).
 *
 * The page did not send them, so it learns of them from
 * `/api/subagents/events` — a snapshot on connect, then every run that starts
 * — and attaches the ordinary turn runner to each one. From there a subagent
 * chat is indistinguishable from one the user is driving: it joins the
 * sidebar, says Working, streams into the transcript through the same
 * reducer, notifies when it ends, and Stop stops it. A reload re-attaches to
 * whatever is still running, because the snapshot names it.
 */
export function useSubagents({
  refs,
  runPrompt,
  loadThread,
  setSessions,
}: {
  refs: ChatRefs
  runPrompt: RunPrompt
  loadThread: LoadThread
  setSessions: React.Dispatch<React.SetStateAction<SessionMeta[]>>
}) {
  const { abortsRef } = refs
  // Read through refs: the subscription is opened once, and a reconnect must
  // not be the price of a new `runPrompt` identity.
  const runPromptRef = React.useRef(runPrompt)
  const loadThreadRef = React.useRef(loadThread)
  React.useEffect(() => {
    runPromptRef.current = runPrompt
    loadThreadRef.current = loadThread
  }, [loadThread, runPrompt])

  React.useEffect(() => {
    if (typeof EventSource === "undefined") return
    /** Runs this page is already watching, so a reconnect's snapshot is a no-op. */
    const attached = new Set<string>()

    const attach = async (run: SubagentRunSummary) => {
      if (attached.has(run.runId)) return
      attached.add(run.runId)
      // A turn the user is running in that chat already owns it.
      if (abortsRef.current.has(run.sessionId)) return
      const prior: StoredMessage[] =
        (await loadThreadRef.current(run.sessionId)) ?? []
      void runPromptRef.current({
        sessionId: run.sessionId,
        prompt: run.prompt,
        prior,
        providerId: run.harness,
        model: run.model,
        attach: {
          runId: run.runId,
          userMessageId: run.userMessageId,
          assistantMessageId: run.assistantMessageId,
          startedAt: run.startedAt,
        },
      })
    }

    const source = new EventSource("/api/subagents/events")
    source.onmessage = (message) => {
      let frame: ServerFrame
      try {
        frame = JSON.parse(message.data) as ServerFrame
      } catch {
        return
      }
      if (frame.type === "snapshot") {
        for (const run of frame.runs) void attach(run)
        return
      }
      if (frame.type === "run-started") {
        const { session } = frame
        setSessions((prev) =>
          prev.some((item) => item.id === session.id)
            ? prev.map((item) =>
                item.id === session.id ? { ...item, ...session } : item
              )
            : [session, ...prev]
        )
        void attach(frame.run)
      }
    }
    return () => source.close()
  }, [abortsRef, setSessions])
}
