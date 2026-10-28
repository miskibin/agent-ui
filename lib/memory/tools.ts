/**
 * The `memory_*` tools the app's MCP server (`/api/mcp`) offers while memory is
 * on — how an agent keeps the store the turn's memory block shows it. Pure: the
 * vocabulary and argument handling; the route injects the file I/O.
 *
 * Three verbs on purpose, the same ones Claude Code's own memory gets by with:
 * read a file, write a whole file, delete one. "Append a fact" is missing by
 * design — it is the operation that turns a memory into a log.
 */

import {
  MAX_MEMORY_FILE_CHARS,
  MAX_MEMORY_FILES,
  toMemoryName,
  type MemoryFile,
} from "@/lib/memory/types"

export type MemoryTools = {
  list(): Promise<MemoryFile[]>
  /** Throws the refusal (`memoryWriteError`) when the write is not allowed. */
  write(input: { name: string; description: string; content: string }): Promise<void>
  /** False when there was no such file. */
  remove(name: string): Promise<boolean>
}

export const MEMORY_TOOL_DEFINITIONS = [
  {
    name: "memory_read",
    description:
      "Reads one of the user's memory files in full (its description and body). Without `name`, lists every file with its description.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name from the memory index, e.g. `preferences`." },
      },
    },
  },
  {
    name: "memory_write",
    description: `Creates or replaces one memory file — the whole file, so include everything that should stay. Prefer updating the existing file a topic belongs to over creating a new one; there is a limit of ${MAX_MEMORY_FILES} files and ${MAX_MEMORY_FILE_CHARS} characters per file.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Topic name, lowercase with dashes (`preferences`, `stack`, `workflow`).",
        },
        description: {
          type: "string",
          description: "One line: what this file holds and when it matters.",
        },
        content: {
          type: "string",
          description: "Markdown body: short bullet points, one durable fact each.",
        },
      },
      required: ["name", "description", "content"],
    },
  },
  {
    name: "memory_delete",
    description:
      "Deletes one memory file — when everything in it is obsolete, after merging it into another, or when the user asks to forget it.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
] as const

export const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set(
  MEMORY_TOOL_DEFINITIONS.map((tool) => tool.name)
)

type Answer = { data: unknown; isError?: boolean }

function str(value: unknown) {
  return typeof value === "string" ? value : ""
}

/** One `memory_*` call. Failures come back as tool errors, never throws. */
export async function callMemoryTool(
  tools: MemoryTools,
  name: string,
  args: Record<string, unknown>
): Promise<Answer> {
  try {
    switch (name) {
      case "memory_read": {
        const files = await tools.list()
        const wanted = toMemoryName(str(args.name))
        if (!wanted) {
          return {
            data: {
              files: files.map((file) => ({ name: file.name, description: file.description })),
              limit: MAX_MEMORY_FILES,
            },
          }
        }
        const file = files.find((entry) => entry.name === wanted)
        if (!file) {
          return {
            data: `No memory file "${wanted}". Existing: ${files.map((entry) => entry.name).join(", ") || "none"}.`,
            isError: true,
          }
        }
        return { data: { name: file.name, description: file.description, content: file.content } }
      }
      case "memory_write": {
        const target = toMemoryName(str(args.name))
        const existed = (await tools.list()).some((file) => file.name === target)
        await tools.write({
          name: target,
          description: str(args.description).trim(),
          content: str(args.content).trim(),
        })
        return { data: { name: target, status: existed ? "updated" : "created" } }
      }
      case "memory_delete": {
        const target = toMemoryName(str(args.name))
        const removed = target ? await tools.remove(target) : false
        return removed
          ? { data: { name: target, status: "deleted" } }
          : { data: `No memory file "${target}".`, isError: true }
      }
      default:
        return { data: `Unknown tool "${name}".`, isError: true }
    }
  } catch (err) {
    return { data: err instanceof Error ? err.message : String(err), isError: true }
  }
}
