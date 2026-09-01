"use client"

import * as React from "react"

import type { StoredMessage } from "@/lib/store/types"
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

export function ContextUsage({
  store,
  input,
  output,
  total,
}: {
  store: DraftStore
  /** Prompt tokens the last reporting turn carried. */
  input: number
  /** Tokens that turn generated. */
  output: number
  /** The selected model's window; falsy hides the meter entirely. */
  total: number | undefined
}) {
  const draft = React.useSyncExternalStore(
    store.subscribe,
    store.get,
    () => ""
  )
  if (!total) return null

  const drafted = estimateTokens(draft)
  const used = input + output + drafted
  const measured = input > 0 || output > 0

  return (
    <Popover>
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
        <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
          {measured
            ? "The prompt is what the backend counted; the draft is estimated at four characters per token."
            : "No turn has reported its tokens yet, so this is the draft estimate alone."}
        </p>
      </PopoverContent>
    </Popover>
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
