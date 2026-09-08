/**
 * How much of a context window a piece of text is about to take, and what to
 * drop when it takes more than there is.
 *
 * Pure and free of `node:`, because both sides of the app need it: the
 * composer's context meter runs it in the browser over the open transcript,
 * and `lib/completion.ts` runs it on the server to size the window it asks a
 * local model for. One definition, so the meter and the request can never
 * disagree about what "too long" means.
 *
 * Four characters per token is the usual rough figure for English prose and
 * code. It is an estimate and is treated as one — every caller keeps headroom
 * rather than filling the window to the last token.
 */

export const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / CHARS_PER_TOKEN)
}

/** What was cut, said in the text itself rather than silently. */
const ELISION = "\n\n[… trimmed to fit the model's context window …]"

export type SizedMessage = { role: string; content: string }

/**
 * The messages, shortened until the estimate fits `budget` tokens.
 *
 * The longest message is the one that gets cut, and it is cut from the *tail*.
 * Both halves of that are deliberate. Evidence in this app is assembled
 * headline-first — a commit prompt puts the `--name-status` summary before the
 * patch, a title prompt puts the oldest turns before the newest — so the head
 * is the part that survives losing the rest. And a system prompt is rules
 * rather than evidence: cutting the biggest message leaves it alone until it
 * is the only thing left to cut, which is the right last resort.
 *
 * The cut is announced in the text. A model handed a patch that stops
 * mid-hunk with no explanation writes a commit message about half a change;
 * one told the tail was trimmed writes about what it can see.
 */
export function fitMessagesToContext<T extends SizedMessage>(
  messages: T[],
  budget: number
): T[] {
  if (budget <= 0) return messages
  let current = messages
  // Each pass cuts whichever message is longest *now*, so a prompt made of two
  // large messages loses from both rather than gutting one and keeping the
  // other whole. Bounded by the message count: every pass strictly shortens
  // the longest one, and once they are all at the floor there is nothing left
  // to try.
  for (let pass = 0; pass <= messages.length; pass += 1) {
    const total = current.reduce(
      (sum, message) => sum + estimateTokens(message.content),
      0
    )
    if (total <= budget) return current
    let longest = 0
    for (let index = 1; index < current.length; index += 1) {
      if (current[index].content.length > current[longest].content.length) {
        longest = index
      }
    }
    const excess = total - budget
    const target =
      current[longest].content.length - (excess + ELISION.length / CHARS_PER_TOKEN) * CHARS_PER_TOKEN
    // Never below a floor: a message cut to nothing tells the model less than
    // one cut to its first paragraph, and the next pass would cut the other.
    const keep = Math.max(0, Math.floor(target))
    if (keep >= current[longest].content.length) return current
    current = current.map((message, index) =>
      index === longest
        ? { ...message, content: message.content.slice(0, keep).trimEnd() + ELISION }
        : message
    )
  }
  return current
}
