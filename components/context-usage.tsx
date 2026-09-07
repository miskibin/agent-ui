"use client"

import * as React from "react"

import { formatCost } from "@/lib/model-pricing"
import type { DiscoveredCommand } from "@/lib/skills"
import type { StoredMessage } from "@/lib/store/types"
import { CACHE_COMPACT_HINT_KEY, readCache, writeCache } from "@/lib/ui-cache"
import { cn } from "@/lib/utils"
import { ContextMeter, formatTokens } from "@/components/ui/context-meter"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/**
 * The context ring for the composer toolbar, and the plumbing that keeps it
 * off the page's render path.
 *
 * The draft has to reach the meter on every keystroke, and routing that
 * through `page.tsx` state would re-render the whole page — the one thing the
 * composer is memoized to avoid. So the draft lives in a tiny store instead,
 * and only this component subscribes to it.
 */

export type DraftStore = {
  subscribe: (listener: () => void) => () => void
  get: () => string
  set: (text: string) => void
}

/** Four characters to a token: wrong in the third digit, right in the first. */
const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / CHARS_PER_TOKEN)
}

function createDraftStore(): DraftStore {
  const listeners = new Set<() => void>()
  let text = ""
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get: () => text,
    set(next) {
      if (next === text) return
      text = next
      for (const listener of listeners) listener()
    },
  }
}

/**
 * One store for the life of the page, so `set` is stable enough to hand to a
 * memoized composer. Lazy `useState` rather than a ref: a ref may not be read
 * during render.
 */
export function useDraftStore(): DraftStore {
  const [store] = React.useState(createDraftStore)
  return store
}

/**
 * What the *next* request would carry: what the last turn actually cost, plus
 * an estimate of the draft on top of it.
 *
 * The backend's own count is the honest half — a harness pays for a system
 * prompt, tool schemas and whatever files it read, none of which the client
 * can see. Until a turn has reported one there is nothing but the estimate,
 * which is why the meter reads low on a brand-new chat.
 */
export type TurnUsage = { input: number; output: number }

const NO_USAGE: TurnUsage = { input: 0, output: 0 }

/**
 * Cheap enough to run on every render — it stops at the first turn that
 * reported anything — and it returns plain numbers on purpose: the composer
 * that receives them is memoized, and an object rebuilt per frame would defeat
 * that where two primitives do not.
 */
export function contextTurnUsage(messages: StoredMessage[]): TurnUsage {
  for (let index = messages.length - 1; index >= 0; index--) {
    const { metadata } = messages[index]
    if (!metadata) continue
    const { inputTokens, outputTokens } = metadata
    if (inputTokens == null && outputTokens == null) continue
    return { input: inputTokens ?? 0, output: outputTokens ?? 0 }
  }
  return NO_USAGE
}

/* -------------------------------------------------------------------------- */
/* Compaction                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The harness this app spells `claudeCode` and its own transcripts spell
 * `claude-code`. Written out rather than imported: `lib/providers/claude-code`
 * is `server-only`, and this is a client component.
 */
const CLAUDE_CODE_ID = "claudeCode"

/** Past this much context, resuming a stale conversation is worth a word. */
export const RESUME_COMPACTION_TOKENS = 100_000
/** And past this long away from it. */
export const RESUME_COMPACTION_MINUTES = 70

/**
 * Whether the harness in this chat can shorten its own conversation.
 *
 * Claude Code always can — `/compact` is one of its CLI's own commands — and
 * any other harness is believed only when the scan actually found that command
 * on this machine (`app/hooks/use-skills`). Offering a button that sends a
 * `/x` the backend has never heard of would put a stray line in the transcript
 * and call it a feature.
 */
export function canCompactContext(
  providerId: string,
  commands: readonly DiscoveredCommand[]
): boolean {
  return (
    providerId === CLAUDE_CODE_ID ||
    commands.some((command) => command.name === "compact")
  )
}

/**
 * Whether reopening this chat is worth an offer to compact it first.
 *
 * Ported from T3 Code's `ContextWindowMeter.logic`: a Claude Code conversation
 * that is already large and has been sitting for over an hour is the one case
 * where the next turn is likely to spend its first minutes on context nobody
 * needs. Everything else — a short chat, a fresh one, another harness — is
 * left alone, because an offer made too often is an offer nobody reads.
 *
 * Pure, and takes its clock as an argument: a render may not read one.
 */
export function shouldOfferResumeCompaction({
  providerId,
  usedTokens,
  lastTurnAt,
  now,
}: {
  providerId: string | undefined
  /** What the last reporting turn actually carried. */
  usedTokens: number | undefined
  /** When that turn settled — `metadata.finishedAt`. */
  lastTurnAt: number | undefined
  now: number
}): boolean {
  if (providerId !== CLAUDE_CODE_ID) return false
  if ((usedTokens ?? 0) < RESUME_COMPACTION_TOKENS) return false
  const settled = lastTurnAt ?? 0
  if (!Number.isFinite(settled) || settled <= 0) return false
  return now - settled >= RESUME_COMPACTION_MINUTES * 60_000
}

export function ContextUsage({
  store,
  input,
  output,
  total,
  cost,
  sessionId = "",
  providerId = "",
  lastTurnAt,
  canCompact = false,
  onCompact,
}: {
  store: DraftStore
  /** Prompt tokens the last reporting turn carried. */
  input: number
  /** Tokens that turn generated. */
  output: number
  /** The selected model's window; falsy hides the meter entirely. */
  total: number | undefined
  /** Dollars the chat has spent so far, per `lib/usage`; null = unknown. */
  cost?: number | null
  /** The open chat — what the resume offer is remembered against. */
  sessionId?: string
  /** Its harness, for both the action and the offer. */
  providerId?: string
  /** When its newest turn settled (`use-thread-view`). */
  lastTurnAt?: number
  /** Whether that harness has a compaction command — `canCompactContext`. */
  canCompact?: boolean
  /** Sends it. Absent = no action and no offer. */
  onCompact?: () => void
}) {
  const draft = React.useSyncExternalStore(
    store.subscribe,
    store.get,
    () => ""
  )
  const [open, setOpen] = React.useState(false)
  /** "Don't ask again": one flag for every chat, across reloads. */
  const [askedNever, setAskedNever] = React.useState(
    () => readCache<boolean>(CACHE_COMPACT_HINT_KEY) === true
  )
  /** And the chats the offer has already been answered for in this session. */
  const [answered, setAnswered] = React.useState<readonly string[]>([])

  /**
   * When this chat was opened. The offer is about *resuming*, so the clock it
   * is measured against is read once per chat rather than on every render —
   * which is also what keeps the render itself free of a `Date.now()`.
   */
  const [opened, setOpened] = React.useState<{ id: string; at: number } | null>(
    null
  )
  React.useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    // Deferred: a synchronous setState in an effect body is a cascading render.
    queueMicrotask(() => {
      if (!cancelled) setOpened({ id: sessionId, at: Date.now() })
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const compactable = canCompact && !!onCompact
  const offerResume =
    compactable &&
    !askedNever &&
    opened?.id === sessionId &&
    !answered.includes(sessionId) &&
    shouldOfferResumeCompaction({
      providerId,
      usedTokens: input + output,
      lastTurnAt,
      now: opened.at,
    })

  const answerHere = React.useCallback(
    () => setAnswered((current) => [...current, sessionId]),
    [sessionId]
  )
  const compact = React.useCallback(() => {
    setOpen(false)
    answerHere()
    onCompact?.()
  }, [answerHere, onCompact])
  const never = React.useCallback(() => {
    setAskedNever(true)
    writeCache(CACHE_COMPACT_HINT_KEY, true)
  }, [])

  /**
   * The offer stands beside the meter rather than over the conversation: it is
   * a suggestion about the next turn, and nothing about it should be in the
   * way of sending one.
   */
  const hint = offerResume ? (
    <div
      data-slot="context-compact-hint"
      role="status"
      className="flex min-w-0 items-center gap-1.5 rounded-md border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground"
    >
      <button
        type="button"
        onClick={compact}
        className="truncate rounded-sm font-medium text-foreground outline-none transition-colors hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        Compact before resuming?
      </button>
      <button
        type="button"
        onClick={never}
        className="shrink-0 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        Don&rsquo;t ask again
      </button>
    </div>
  ) : null

  if (!total) return hint

  const drafted = estimateTokens(draft)
  const used = input + output + drafted
  const measured = input > 0 || output > 0

  return (
    <>
      {hint}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* `showFrom={0}`: a 128k window sits under the component's default
              threshold for most of a conversation, and a gauge that only shows
              up once you are in trouble is not a gauge. */}
          <ContextMeter interactive used={used} total={total} showFrom={0} />
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-60 text-[12px]">
          <p className="mb-2 text-[13px] font-medium">Context window</p>
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 tabular-nums">
            <Row label="Used" value={used} />
            <Row label="Free" value={Math.max(0, total - used)} />
            <Row label="Window" value={total} />
          </dl>
          {measured ? (
            <>
              <p className="mt-3 mb-1 text-muted-foreground">Last turn</p>
              <dl className="grid grid-cols-[1fr_auto] gap-y-1 tabular-nums">
                <Row label="Prompt" value={input} />
                <Row label="Reply" value={output} />
              </dl>
            </>
          ) : null}
          {drafted > 0 ? (
            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-y-1 tabular-nums">
              <Row label="Draft" value={drafted} approximate />
            </dl>
          ) : null}
          {cost != null ? (
            <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 tabular-nums">
              <dt className="text-muted-foreground">Spent so far</dt>
              <dd className="text-right" title="Estimated from list prices">
                ≈ {formatCost(cost)}
              </dd>
            </dl>
          ) : null}
          <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
            {measured
              ? "The prompt is what the backend counted; the draft is estimated at four characters per token."
              : "No turn has reported its tokens yet, so this is the draft estimate alone."}
          </p>
          {compactable ? (
            /* One ordinary turn, sent through the composer's own path — the
               harness's `/compact`, not something this app invented. */
            <button
              type="button"
              onClick={compact}
              className={cn(
                "mt-3 w-full rounded-md border px-2 py-1 text-[12px] font-medium outline-none",
                "transition-colors hover:bg-accent hover:text-accent-foreground",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50"
              )}
            >
              Compact context
            </button>
          ) : null}
        </PopoverContent>
      </Popover>
    </>
  )
}

function Row({
  label,
  value,
  approximate = false,
}: {
  label: string
  value: number
  approximate?: boolean
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">
        {approximate ? "~" : ""}
        {formatTokens(value)}
      </dd>
    </>
  )
}
