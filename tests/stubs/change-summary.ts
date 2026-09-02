/**
 * Stand-in for `@/components/ui/change-summary` under `node --test`.
 *
 * The vendored component is `.tsx`, and Node's strip-only TypeScript loader
 * refuses JSX — so `lib/turn-files.ts`, which imports one pure function out of
 * it, cannot be loaded at all without this. Everything below is copied
 * verbatim from the vendored file; if that file's `fileChangesFromTools`
 * changes, copy it again rather than paraphrasing it here.
 */

export type ChangeSummaryFile = {
  path: string
  additions?: number
  deletions?: number
}

export type ChangeSummaryTool = {
  name: string
  status?: "pending" | "running" | "done" | "error"
  input?: string
  output?: string
}

function parseArgs(input?: string): Record<string, unknown> {
  if (!input?.trim()) return {}
  try {
    const value = JSON.parse(input) as unknown
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    /* raw */
  }
  return {}
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function isFileMutationTool(name: string) {
  const kind = name.replace(/\s+/g, "").toLowerCase()
  return (
    kind.includes("write") ||
    kind.includes("createfile") ||
    kind.includes("edit") ||
    kind.includes("applypatch") ||
    kind.includes("searchreplace") ||
    kind.includes("strreplace")
  )
}

function parseOutputStats(output?: string) {
  if (!output) return { additions: 0, deletions: 0 }
  const added = output.match(/\+(\d+)/)
  const removed = output.match(/[-−](\d+)/)
  return {
    additions: added ? Number(added[1]) : 0,
    deletions: removed ? Number(removed[1]) : 0,
  }
}

function countUnifiedDiff(patch?: string) {
  if (!patch) return { additions: 0, deletions: 0 }
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions++
    else if (line.startsWith("-")) deletions++
  }
  return { additions, deletions }
}

export function fileChangesFromTools(
  tools: ChangeSummaryTool[]
): ChangeSummaryFile[] {
  const byPath = new Map<string, ChangeSummaryFile>()

  for (const tool of tools) {
    if (tool.status && tool.status !== "done") continue
    if (!isFileMutationTool(tool.name)) continue
    const args = parseArgs(tool.input)
    const path =
      asString(args.path) ??
      asString(args.filePath) ??
      asString(args.target_file) ??
      asString(args.file)
    if (!path) continue

    const fromOutput = parseOutputStats(tool.output)
    const fromDiff = countUnifiedDiff(
      asString(args.diff) ?? asString(args.patch) ?? asString(args.diffString)
    )
    const additions = fromOutput.additions || fromDiff.additions
    const deletions = fromOutput.deletions || fromDiff.deletions
    const existing = byPath.get(path)
    if (existing) {
      existing.additions = (existing.additions ?? 0) + additions
      existing.deletions = (existing.deletions ?? 0) + deletions
    } else {
      byPath.set(path, { path, additions, deletions })
    }
  }

  return [...byPath.values()]
}
