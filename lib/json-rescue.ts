// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * Getting the JSON out of what a small model actually said.
 *
 * The app asks local models for structured answers — the categories the memory
 * extractor should rewrite, a chat title — and the servers that can enforce a
 * schema do. The ones that cannot are asked for `format: "json"` instead, and
 * a 3B model handed that will still open with "Here is the JSON:", wrap the
 * object in a ```json fence, or add a sentence after the closing brace. A bare
 * `JSON.parse` throws on every one of those and the whole extraction is lost
 * over punctuation.
 *
 * So the object is found rather than assumed: from the first `{`, count braces
 * until the matching `}` — skipping anything inside a string, and skipping the
 * character after a backslash, so a `}` in a value cannot end the scan early.
 * Nothing is repaired: what comes back is a slice of the input, and it is
 * still `JSON.parse` that decides whether it was JSON.
 */

/** The first brace-balanced object in `raw`, or the trimmed input unchanged. */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim()
  const start = trimmed.indexOf("{")
  if (start < 0) return trimmed

  let depth = 0
  let inString = false
  let escaping = false
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (inString) {
      if (escaping) escaping = false
      else if (char === "\\") escaping = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{") {
      depth += 1
      continue
    }
    if (char === "}") {
      depth -= 1
      // Balanced: everything after this brace is the model's commentary.
      if (depth === 0) return trimmed.slice(start, index + 1)
    }
  }

  // Truncated output: hand back what there is and let the parse fail honestly.
  return trimmed.slice(start)
}

/**
 * `JSON.parse` of the object inside `raw`, or undefined. Never throws, so a
 * caller can treat "the model said nothing usable" as the empty result rather
 * than as a failed request.
 */
export function parseJsonObject<T = unknown>(raw: string): T | undefined {
  try {
    return JSON.parse(extractJsonObject(raw)) as T
  } catch {
    return undefined
  }
}
