/**
 * Composite model ids — `"<source>/<model>"`, where `source` is a model
 * provider slug (`lib/model-providers/presets`) or `"ollama"` for the local
 * server.
 *
 * Only the *first* slash separates the two halves: hosted catalogs hand out
 * ids that contain slashes of their own (`openai/gpt-4o` on OpenRouter,
 * `hf.co/…` on Ollama), and those belong to the model, not to the source.
 */

const OLLAMA_SOURCE = "ollama"

/**
 * A bare id — no slash at all, or nothing before the first one — is a model id
 * stored before providers were first-class, and those were always Ollama's.
 */
export function splitModelId(id: string): { source: string; model: string } {
  const cut = id.indexOf("/")
  if (cut <= 0) return { source: OLLAMA_SOURCE, model: id }
  return { source: id.slice(0, cut), model: id.slice(cut + 1) }
}

export function joinModelId(source: string, model: string): string {
  return `${source}/${model}`
}
