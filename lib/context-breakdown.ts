import { CHARS_PER_TOKEN } from "@/lib/token-estimate"

/**
 * What the composer's context ring breaks the window into when it is opened —
 * the same picture Claude Code's own context panel draws, from what this app
 * can actually know.
 *
 * The backend's count of the last prompt is the one measured number, and it
 * covers everything the backend sent: the conversation, and the part a client
 * never sees (system prompt, tool schemas, memory, skills). So
 * the conversation is *estimated* from the stored transcript and the rest of
 * the measured prompt is attributed to that unseen setup. Both halves are
 * labelled for what they are; the estimate is never allowed to exceed the
 * measurement it is carved out of.
 *
 * Pure and free of `node:`, so `node --test` can drive it.
 */

/** The parts of a stored message that travel back to the model. */
type TranscriptMessage = {
  content: string
  tools?: Array<{ input?: string; output?: string }>
}

/**
 * The conversation's size by the four-characters rule: every message's text
 * and its tool calls — tool output is usually most of a coding transcript.
 */
export function transcriptTokens(messages: readonly TranscriptMessage[]): number {
  let chars = 0
  for (const message of messages) {
    chars += message.content.length
    for (const tool of message.tools ?? []) {
      chars += (tool.input?.length ?? 0) + (tool.output?.length ?? 0)
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export type ContextSegmentId = "setup" | "messages" | "draft"

export type ContextSegment = {
  id: ContextSegmentId
  label: string
  tokens: number
  /** Derived by the four-characters rule rather than counted by the backend. */
  estimated: boolean
}

export type ContextBreakdown = {
  segments: ContextSegment[]
  used: number
  free: number
  total: number
}

/**
 * The window, split. What the last turn left behind — its prompt plus its
 * reply — is what the next request starts from, and the transcript estimate
 * is carved out of that as the messages; the remainder is what the harness
 * sends that no transcript shows. Segments with nothing in them are left out,
 * and they never add up to more than the window: a backend can report a
 * prompt larger than the window it states (a compaction in flight, a cache
 * counted twice), and a bar that overflows its own track says nothing useful.
 */
export function contextBreakdown({
  prompt,
  output,
  conversation,
  draft,
  total,
}: {
  /** Prompt tokens the last turn reported; 0 when no turn has. */
  prompt: number
  /** Tokens that turn generated. */
  output: number
  /** `transcriptTokens` of the whole conversation. */
  conversation: number
  /** The composer's draft, estimated. */
  draft: number
  total: number
}): ContextBreakdown {
  const carried = prompt + output
  const measured = carried > 0
  // Without a measured turn the transcript estimate is all there is.
  const messages = measured ? Math.min(conversation, carried) : conversation
  const segments: ContextSegment[] = [
    ...(measured
      ? [
          {
            id: "setup" as const,
            label: "System & tools",
            tokens: carried - messages,
            estimated: true,
          },
        ]
      : []),
    { id: "messages" as const, label: "Messages", tokens: messages, estimated: true },
    { id: "draft" as const, label: "Draft", tokens: draft, estimated: true },
  ].filter((segment) => segment.tokens > 0)

  let room = Math.max(0, total)
  for (const segment of segments) {
    segment.tokens = Math.min(segment.tokens, room)
    room -= segment.tokens
  }
  const used = segments.reduce((sum, segment) => sum + segment.tokens, 0)
  return {
    segments: segments.filter((segment) => segment.tokens > 0),
    used,
    free: Math.max(0, total - used),
    total,
  }
}
