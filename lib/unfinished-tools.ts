import type { AgentStreamEvent } from "@/lib/cursor-agent-types"

/**
 * The tool rows a turn started and never closed.
 *
 * A run that ends abnormally — the user stopped it, the binary never started,
 * the process exited non-zero, the stream stopped before the harness sent its
 * final result — leaves every in-flight `tool` event at `status: "running"`.
 * The row then spins forever, and the stored transcript reads as a call that
 * is still going: a handoff built from it says "running `pytest`" about a
 * command that died with the process.
 *
 * The tracker is fed the same events the turn yields, so it needs no
 * per-harness knowledge: an id that arrives `running` is open, and the same id
 * arriving `done` or `error` closes it. `lib/message-stream.ts#upsertToolPart`
 * merges by id, so the terminal events below refine the rows already on screen
 * rather than adding new ones.
 */

/** What an unfinished row is closed with. Short: it is rendered on the row. */
export const UNFINISHED_TOOL_OUTPUT = "Interrupted"

export class UnfinishedTools {
  private readonly open = new Map<string, string>()

  /** Feed every event the turn emits; only `tool` events are read. */
  track(event: AgentStreamEvent): void {
    if (event.type !== "tool") return
    if (event.status === "running") this.open.set(event.id, event.name)
    else this.open.delete(event.id)
  }

  get size(): number {
    return this.open.size
  }

  /** One terminal event per still-open row, and the tracker is emptied. */
  *finish(
    output: string = UNFINISHED_TOOL_OUTPUT
  ): Generator<AgentStreamEvent> {
    for (const [id, name] of this.open) {
      yield { type: "tool", id, name, status: "error", output }
    }
    this.open.clear()
  }
}
