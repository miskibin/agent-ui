import type { GenerationStage } from "@/components/ui/generation-status"
import type { AgentStatusStage } from "@/lib/cursor-agent-types"
import type { ProviderInfo } from "@/lib/providers/types"
import type { SessionMeta } from "@/lib/store/types"

/**
 * Small pure helpers behind the chat page. Deliberately free of React and of
 * any module state, so each one can be read — and unit tested — on its own;
 * the page and its hooks import them rather than redefining them.
 */

/** Wall clock read, hoisted out of the components so render stays pure. */
export function nowMs() {
  return Date.now()
}

/** Compact sidebar timestamp — "now", "2m", "3h", "5d". */
export function relativeTime(from: number, now: number) {
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 60) return "now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Elapsed wall time for a live Working label — "12s", "1m 04s". */
export function formatElapsed(from: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}

/** Pinning floats a chat to the top; drag-to-reorder owns the order after that. */
export function pinToTop(sessions: SessionMeta[], id: string) {
  const index = sessions.findIndex((session) => session.id === id)
  if (index < 0) return sessions
  const next = [...sessions]
  const [item] = next.splice(index, 1)
  return [{ ...item, pinned: true }, ...next]
}

/** The preferred harness while it is available, else the first one that is. */
export function pickProvider(list: ProviderInfo[], preferred: string) {
  const wanted = list.find((item) => item.id === preferred)
  if (wanted?.available) return wanted.id
  return list.find((item) => item.available)?.id ?? preferred ?? ""
}

/**
 * The folder the run actually used, for the details popover. Read from the
 * sidebar mirror rather than passed down, so a turn that started before the
 * folder was set still records the one the route ran in.
 */
export function folderMetadata(sessions: SessionMeta[], sessionId: string) {
  const session = sessions.find((item) => item.id === sessionId)
  if (!session?.cwd) return null
  return {
    cwd: session.cwd,
    ...(session.gitBranch ? { gitBranch: session.gitBranch } : null),
  }
}

/**
 * `AgentStatusStage` is finer than the indicator's three stages: setup phases
 * have no dot of their own, and read as thinking.
 */
export function statusStage(
  stage: AgentStatusStage | undefined
): GenerationStage {
  return stage === "searching" || stage === "responding" ? stage : "thinking"
}

/** Drops one key, returning the same object when there was nothing to drop. */
export function omit<T>(
  record: Record<string, T>,
  key: string
): Record<string, T> {
  if (record[key] === undefined) return record
  const next = { ...record }
  delete next[key]
  return next
}

export function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback
}
