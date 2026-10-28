import type { SessionMeta } from "@/lib/store/types"

/** Shared by the server's run registry and the page that watches it. */

/** `queued`: a follow-up waiting for the chat's current turn to end. */
export type SubagentStatus = "queued" | "running" | "done" | "error" | "cancelled"

export type SubagentRunSummary = {
  runId: string
  sessionId: string
  parentId?: string
  harness: string
  model: string
  title: string
  prompt: string
  cwd?: string
  status: SubagentStatus
  startedAt: number
  finishedAt?: number
  userMessageId: string
  assistantMessageId: string
  error?: string
}

export type SubagentBusEvent =
  | { type: "run-started"; run: SubagentRunSummary; session: SessionMeta }
  | { type: "run-ended"; run: SubagentRunSummary }
