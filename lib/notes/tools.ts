/**
 * The `note_*` tools the app's MCP server (`/api/mcp?note=<id>`) offers to the
 * agent a note's ask runs — the only way it touches the note. Pure: the
 * vocabulary and argument handling; the route injects the store.
 *
 * Two verbs, after Claude Docs: read the note as blocks with ids, and edit by
 * those ids. The guard is the id itself (`lib/notes/blocks`), so an edit to a
 * block the person changed after the agent read it is refused with a message
 * that says to re-read — their words win, every time.
 */

import {
  describeBlocks,
  splitBlocks,
  type NoteOp,
  type NoteOpsResult,
} from "@/lib/notes/blocks"

export type NoteTools = {
  read(): Promise<{ rev: number; title: string; content: string }>
  /** The note as it stood at `rev`, when that revision is still kept. */
  readAt(rev: number): Promise<string | undefined>
  /** Applies the ops atomically against the note as it stands now. */
  edit(ops: NoteOp[]): Promise<{ rev: number; result: NoteOpsResult }>
}

export const NOTE_INSTRUCTIONS =
  "You are working in a markdown note the person is editing at the same time. Read it with note_read and change it only with note_edit, aiming at block ids. Change only what was asked; every other word stays. Plant a pending placeholder before writing anything longer than a sentence, then replace it."

export const NOTE_TOOL_DEFINITIONS = [
  {
    name: "note_read",
    description:
      "Reads the note as blocks: {rev, title, blocks:[{id, type, markdown}]}. Pass since_rev (the rev your last read or edit returned) to get only the blocks added or changed since, plus the ids that are gone.",
    inputSchema: {
      type: "object",
      properties: {
        since_rev: { type: "number", description: "Return only what changed after this rev." },
      },
    },
  },
  {
    name: "note_edit",
    description:
      'Edits the note by block id; ops apply in order, all or nothing. Ops: replace {id, markdown} · insert {after|before: id|"start"|"end", markdown} · delete {id} · replace_text {find, with, id?} (exact words that occur once) · pending {after|before, intent} plants a visible placeholder — fill it with replace on the id it returns. An id is a hash of the block\'s words, so an op on a block that changed since you read it is refused: read again and work from what stands. Diagrams are ```mermaid fences, math $…$ and $$…$$. Returns the new rev and the ids each op wrote.',
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["replace", "insert", "delete", "replace_text", "pending"] },
              id: { type: "string", description: "Block id from note_read." },
              after: { type: "string", description: 'Block id, "start" or "end".' },
              before: { type: "string", description: 'Block id or "start".' },
              markdown: { type: "string" },
              find: { type: "string" },
              with: { type: "string" },
              intent: { type: "string", description: "What will land here, in a few words." },
            },
            required: ["op"],
          },
        },
      },
      required: ["ops"],
    },
  },
] as const

export const NOTE_TOOL_NAMES: ReadonlySet<string> = new Set(
  NOTE_TOOL_DEFINITIONS.map((tool) => tool.name)
)

type Answer = { data: unknown; isError?: boolean }

function str(value: unknown) {
  return typeof value === "string" ? value : undefined
}

export function parseNoteOps(raw: unknown): NoteOp[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "`ops` must be a non-empty array."
  if (raw.length > 50) return "At most 50 ops per call."
  const ops: NoteOp[] = []
  for (const [index, entry] of raw.entries()) {
    const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {}
    const op = str(value.op)
    const id = str(value.id)
    const markdown = str(value.markdown)
    const position = { ...(str(value.after) ? { after: str(value.after) } : null), ...(str(value.before) ? { before: str(value.before) } : null) }
    switch (op) {
      case "replace":
        if (!id || markdown === undefined) return `ops[${index}]: replace needs id and markdown.`
        ops.push({ op, id, markdown })
        break
      case "delete":
        if (!id) return `ops[${index}]: delete needs id.`
        ops.push({ op, id })
        break
      case "insert":
        if (markdown === undefined) return `ops[${index}]: insert needs markdown.`
        ops.push({ op, markdown, ...position })
        break
      case "pending":
        ops.push({ op, intent: str(value.intent) ?? "", ...position })
        break
      case "replace_text": {
        const find = str(value.find)
        const replacement = str(value.with)
        if (!find || replacement === undefined) return `ops[${index}]: replace_text needs find and with.`
        ops.push({ op, find, with: replacement, ...(id ? { id } : null) })
        break
      }
      default:
        return `ops[${index}]: unknown op "${op ?? ""}".`
    }
  }
  return ops
}

/** One `note_*` call. Failures come back as tool errors, never throws. */
export async function callNoteTool(
  tools: NoteTools,
  name: string,
  args: Record<string, unknown>
): Promise<Answer> {
  try {
    switch (name) {
      case "note_read": {
        const note = await tools.read()
        const blocks = splitBlocks(note.content)
        const since = typeof args.since_rev === "number" ? args.since_rev : undefined
        if (since !== undefined && since < note.rev) {
          const before = await tools.readAt(since)
          if (before !== undefined) {
            const had = new Set(splitBlocks(before).map((block) => block.id))
            const now = new Set(blocks.map((block) => block.id))
            return {
              data: {
                rev: note.rev,
                title: note.title,
                since_rev: since,
                ...describeBlocks(blocks.filter((block) => !had.has(block.id))),
                gone: [...had].filter((id) => !now.has(id)),
                unchanged: blocks.filter((block) => had.has(block.id)).length,
              },
            }
          }
        }
        return { data: { rev: note.rev, title: note.title, ...describeBlocks(blocks) } }
      }
      case "note_edit": {
        const ops = parseNoteOps(args.ops)
        if (typeof ops === "string") return { data: ops, isError: true }
        const { rev, result } = await tools.edit(ops)
        if (!result.ok) {
          return {
            data: `Nothing was changed. ops[${result.error.index}] (${result.error.code}): ${result.error.message}`,
            isError: true,
          }
        }
        return {
          data: {
            rev,
            written: result.written,
            ...(result.pending.length ? { pending: result.pending } : null),
          },
        }
      }
      default:
        return { data: `Unknown tool "${name}".`, isError: true }
    }
  } catch (err) {
    return { data: err instanceof Error ? err.message : String(err), isError: true }
  }
}
