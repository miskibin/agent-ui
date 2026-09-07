/**
 * Context windows the Claude Code CLI itself reported, remembered per model
 * for as long as the server runs.
 *
 * The model picker's meter needs a number before the first token of a turn,
 * so `lib/providers/claude-code.ts` ships a static one per model. A finished
 * turn knows better: `result.modelUsage[*].contextWindow` is the window the
 * CLI actually held the conversation against — which is where a `[1m]`
 * variant, an enterprise deployment or a model released after this app was
 * built differ from the static guess. Whatever a run learns is written here
 * and read the next time the picker is built.
 *
 * Deliberately in-memory and deliberately not persisted: it is a refinement
 * of a fallback, and a stale one on disk would outlive the deployment that
 * produced it. No imports, so both halves of the harness can read it — the
 * spawn path and the provider that must not pull `child_process` in.
 */

const observed = new Map<string, number>()

/** Both spellings a turn knows: the id the user picked and the one it ran. */
export function rememberContextWindow(
  models: Array<string | undefined>,
  tokens: number | undefined
): void {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return
  for (const model of models) {
    const key = model?.trim().toLowerCase()
    if (key) observed.set(key, Math.round(tokens))
  }
}

/** The window a run reported for this model, or `undefined` if none has. */
export function observedContextWindow(model: string): number | undefined {
  return observed.get(model.trim().toLowerCase())
}
