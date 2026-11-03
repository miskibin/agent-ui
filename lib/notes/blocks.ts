/**
 * A note seen as blocks — the unit an agent reads, aims at and rewrites.
 *
 * The shape is borrowed from Claude Docs: every top-level block has an id an
 * agent can name, an edit names the block it means, and an edit to a block
 * that changed since the agent read it is *refused* rather than written over
 * the person's words. Here the id is the guard: it is a hash of the block's
 * content, so a block someone retyped no longer has the id the agent holds,
 * and every block nobody touched keeps its id across any number of edits
 * elsewhere — no revision bookkeeping on either side.
 *
 * The hash is taken over the block's *words*, not its markdown spelling. The
 * editor re-serializes what it saves (`*` bullets become `-`, emphasis is
 * respelled, escapes come and go), and a guard that tripped on that would
 * refuse edits to blocks nobody changed.
 *
 * Pure and free of `node:`, so `node --test` loads it and the page could too.
 */

export const PENDING_LANGUAGE = "agent-pending"

export type NoteBlockType =
  | "frontmatter"
  | "heading"
  | "paragraph"
  | "list"
  | "quote"
  | "table"
  | "code"
  | "math"
  | "pending"
  | "rule"
  | "html"

export type NoteBlock = {
  id: string
  type: NoteBlockType
  /** Heading level, or the fence language of a code block. */
  detail?: string
  /** `[start, end)` in the source — the block's own text, no blank lines. */
  start: number
  end: number
  text: string
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)?.*$/
const HEADING = /^ {0,3}(#{1,6})(\s|$)/
const LIST = /^\s*([-*+]|\d{1,9}[.)])(\s|$)/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const MATH_FENCE = /^ {0,3}\$\$\s*$/

function fenceClose(line: string, marker: string) {
  const trimmed = line.trim()
  return (
    trimmed.length >= marker.length &&
    trimmed[0] === marker[0] &&
    new RegExp(`^\\${marker[0]}{${marker.length},}$`).test(trimmed)
  )
}

/** FNV-1a, 32 bits, as eight hex characters. */
export function hashText(text: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/**
 * The words of a block, with the markdown spelling taken out: markers,
 * emphasis, escapes and spacing. Code and math keep every character — there
 * the spelling *is* the content.
 */
export function blockWords(block: Pick<NoteBlock, "type" | "text">) {
  if (block.type === "code" || block.type === "math" || block.type === "pending") {
    return block.text.replace(/[ \t]+$/gm, "")
  }
  return block.text
    .replace(/\\(.)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/gm, "")
    .replace(/[*_~`#>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function blockKey(block: Pick<NoteBlock, "type" | "text" | "detail">) {
  const kind = block.type === "heading" ? `h${block.detail}` : block.type
  return `${kind}\u0000${blockWords(block)}`
}

function classify(lines: string[]): { type: NoteBlockType; detail?: string } {
  const first = lines[0] ?? ""
  const fence = FENCE.exec(first)
  if (fence && (fence[2].startsWith("`") || fence[2].startsWith("~"))) {
    const lang = (fence[3] ?? "").toLowerCase()
    if (lang === PENDING_LANGUAGE) return { type: "pending" }
    return { type: "code", ...(lang ? { detail: lang } : null) }
  }
  if (MATH_FENCE.test(first)) return { type: "math" }
  const heading = HEADING.exec(first)
  if (heading) return { type: "heading", detail: String(heading[1].length) }
  if (RULE.test(first) && lines.length === 1) return { type: "rule" }
  if (LIST.test(first)) return { type: "list" }
  if (/^ {0,3}>/.test(first)) return { type: "quote" }
  if (
    lines.length > 1 &&
    first.includes("|") &&
    /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[1])
  ) {
    return { type: "table" }
  }
  if (/^ {0,3}<[a-zA-Z!/]/.test(first)) return { type: "html" }
  return { type: "paragraph" }
}

/**
 * Splits markdown into its top-level blocks. Line-based on purpose: the
 * boundaries an agent sees must be the ones a person sees, and every rule
 * here is one of those — a blank line ends a block, except inside a fence or
 * display math; a heading is always its own block; a list keeps its loose
 * items and indented continuations together; front matter is one block.
 */
export function splitBlocks(source: string): NoteBlock[] {
  const lines = source.split("\n")
  const offsets: number[] = []
  let at = 0
  for (const line of lines) {
    offsets.push(at)
    at += line.length + 1
  }
  const raw: { from: number; to: number; front?: true }[] = []
  let i = 0

  if (lines[0]?.trim() === "---") {
    let j = 1
    while (j < lines.length && lines[j].trim() !== "---" && lines[j].trim() !== "...") j++
    if (j < lines.length) {
      raw.push({ from: 0, to: j, front: true })
      i = j + 1
    }
  }

  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++
      continue
    }
    const from = i
    const startType = classify([lines[i], lines[i + 1] ?? ""]).type
    let j = i
    while (j < lines.length) {
      const line = lines[j]
      const fence = FENCE.exec(line)
      if (fence && fence[2]) {
        // A fence runs to its closer whatever it holds, blank lines included.
        const marker = fence[2]
        j++
        while (j < lines.length && !fenceClose(lines[j], marker)) j++
        j++
        if (startType !== "list") break
        continue
      }
      if (MATH_FENCE.test(line) && j === from) {
        j++
        while (j < lines.length && !MATH_FENCE.test(lines[j])) j++
        j++
        break
      }
      if (HEADING.test(line)) {
        if (j === from) j++
        break
      }
      if (j > from && RULE.test(line) && startType !== "list") break
      if (!line.trim()) {
        // A list survives a blank line when what follows still belongs to it.
        if (startType === "list") {
          let k = j
          while (k < lines.length && !lines[k].trim()) k++
          if (k < lines.length && (LIST.test(lines[k]) || /^(\s{2,}|\t)/.test(lines[k]))) {
            j = k
            continue
          }
        }
        break
      }
      if (j > from && startType !== "list" && FENCE.test(line)) break
      j++
    }
    raw.push({ from, to: Math.min(j, lines.length) - 1 })
    i = Math.max(j, from + 1)
  }

  const seen = new Map<string, number>()
  return raw.map(({ from, to, front }) => {
    let last = to
    while (last > from && !lines[last].trim()) last--
    const { type, detail } = front
      ? { type: "frontmatter" as const, detail: undefined }
      : classify(lines.slice(from, last + 1))
    const start = offsets[from]
    const end = offsets[last] + lines[last].length
    const text = source.slice(start, end)
    const hash = hashText(blockKey({ type, text, detail }))
    const count = (seen.get(hash) ?? 0) + 1
    seen.set(hash, count)
    return {
      id: count > 1 ? `${hash}~${count}` : hash,
      type,
      ...(detail ? { detail } : null),
      start,
      end,
      text,
    }
  })
}

export function noteTitle(source: string) {
  for (const block of splitBlocks(source)) {
    if (block.type === "heading") {
      const title = block.text.replace(/^ {0,3}#{1,6}\s*/, "").replace(/\s*#+\s*$/, "").trim()
      if (title) return title.slice(0, 120)
    }
    if (block.type === "paragraph") break
  }
  return ""
}

export function pendingFence(intent: string) {
  const body = intent.replace(/```/g, "'''").trim() || "Writing…"
  return `\`\`\`${PENDING_LANGUAGE}\n${body}\n\`\`\``
}

/** Every pending placeholder left in the note, taken out. */
export function stripPending(source: string) {
  const pending = splitBlocks(source).filter((block) => block.type === "pending")
  let next = source
  for (const block of pending.reverse()) next = removeRange(next, block)
  return next
}

export type NoteOp =
  | { op: "replace"; id: string; markdown: string }
  | { op: "insert"; after?: string; before?: string; markdown: string }
  | { op: "delete"; id: string }
  | { op: "replace_text"; find: string; with: string; id?: string }
  | { op: "pending"; after?: string; before?: string; intent: string }

export type NoteOpError = {
  /** Which op of the call failed; nothing of the call was applied. */
  index: number
  code: "block_changed" | "not_found" | "ambiguous" | "invalid"
  message: string
}

export type NoteOpsResult =
  | {
      ok: true
      source: string
      /** Ids of the blocks each op wrote, in op order — what to aim at next. */
      written: string[][]
      /** Ids of the pending placeholders this call planted. */
      pending: string[]
    }
  | { ok: false; error: NoteOpError }

function cleanMarkdown(markdown: string) {
  return markdown.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "")
}

function removeRange(source: string, block: Pick<NoteBlock, "start" | "end">) {
  let start = block.start
  let end = block.end
  // Take the blank lines that followed it, so no gap doubles up.
  while (end < source.length && source[end] === "\n") end++
  if (end === source.length) {
    while (start > 0 && source[start - 1] === "\n") start--
    return source.slice(0, start) + (start > 0 ? "\n" : "")
  }
  return source.slice(0, start) + source.slice(end)
}

function insertAt(source: string, position: number, markdown: string, side: "after" | "before") {
  if (!source.trim()) return `${markdown}\n`
  if (side === "after") {
    const head = source.slice(0, position)
    const tail = source.slice(position).replace(/^\n*/, "")
    return `${head}\n\n${markdown}${tail ? `\n\n${tail}` : "\n"}`
  }
  const head = source.slice(0, position).replace(/\n*$/, "")
  const tail = source.slice(position)
  return `${head ? `${head}\n\n` : ""}${markdown}\n\n${tail}`
}

function locate(blocks: NoteBlock[], id: string) {
  return blocks.find((block) => block.id === id)
}

function changedMessage(id: string) {
  return `Block ${id} is not in the note any more — it was edited or removed since you read it. Read the note again and aim at the block as it stands now; never overwrite the person's words with an older version.`
}

/**
 * Ids of the blocks in `next` that are not in `before` — what an op wrote.
 */
function newIds(before: NoteBlock[], next: NoteBlock[]) {
  const had = new Set(before.map((block) => block.id))
  return next.filter((block) => !had.has(block.id)).map((block) => block.id)
}

/**
 * Applies a call's ops in order, all or nothing. Each op is resolved against
 * the note as the ops before it left it, so a call may plant a placeholder
 * and fill it, or insert after the block it just wrote.
 */
export function applyNoteOps(source: string, ops: NoteOp[]): NoteOpsResult {
  let current = source
  const written: string[][] = []
  const pending: string[] = []
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]
    const blocks = splitBlocks(current)
    const fail = (code: NoteOpError["code"], message: string): NoteOpsResult => ({
      ok: false,
      error: { index, code, message },
    })
    let next = current
    switch (op.op) {
      case "replace": {
        const block = locate(blocks, op.id)
        if (!block) return fail("block_changed", changedMessage(op.id))
        const markdown = cleanMarkdown(op.markdown)
        if (!markdown) return fail("invalid", "`markdown` is empty — use the delete op to remove a block.")
        next = current.slice(0, block.start) + markdown + current.slice(block.end)
        break
      }
      case "delete": {
        const block = locate(blocks, op.id)
        if (!block) return fail("block_changed", changedMessage(op.id))
        next = removeRange(current, block)
        break
      }
      case "insert":
      case "pending": {
        const markdown = op.op === "pending" ? pendingFence(op.intent) : cleanMarkdown(op.markdown)
        if (!markdown) return fail("invalid", "`markdown` is empty.")
        const target = op.before ?? op.after ?? "end"
        const side = op.before ? "before" : "after"
        if (target === "end") {
          next = insertAt(current, current.replace(/\s+$/, "").length, markdown, "after")
        } else if (target === "start") {
          const front = blocks[0]?.type === "frontmatter" ? blocks[0] : undefined
          next = front
            ? insertAt(current, front.end, markdown, "after")
            : insertAt(current, 0, markdown, "before")
        } else {
          const block = locate(blocks, target)
          if (!block) return fail("block_changed", changedMessage(target))
          next = insertAt(current, side === "after" ? block.end : block.start, markdown, side)
        }
        break
      }
      case "replace_text": {
        const find = op.find
        if (!find) return fail("invalid", "`find` is empty.")
        const scope = op.id ? locate(blocks, op.id) : undefined
        if (op.id && !scope) return fail("block_changed", changedMessage(op.id))
        const from = scope ? scope.start : 0
        const to = scope ? scope.end : current.length
        const region = current.slice(from, to)
        const first = region.indexOf(find)
        if (first < 0) {
          return fail(
            "not_found",
            `"${find.slice(0, 80)}" is not in the ${scope ? `block ${op.id}` : "note"} as it stands — it may have been edited. Read the note again.`
          )
        }
        if (region.indexOf(find, first + 1) >= 0) {
          return fail("ambiguous", `"${find.slice(0, 80)}" occurs more than once; quote more words or pass the block id.`)
        }
        next = current.slice(0, from + first) + op.with + current.slice(from + first + find.length)
        break
      }
      default:
        return fail("invalid", `Unknown op "${(op as { op?: string }).op}".`)
    }
    const after = splitBlocks(next)
    const ids = newIds(blocks, after)
    written.push(ids)
    if (op.op === "pending") {
      pending.push(...ids.filter((id) => after.find((block) => block.id === id)?.type === "pending"))
    }
    current = next
  }
  return { ok: true, source: current, written, pending }
}

/** The longest common subsequence of two key lists, as index pairs. */
function lcs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) i++
    else j++
  }
  return pairs
}

/** Where each of `small`'s keys sits in `big`, in order — or null when it is not a subsequence. */
function subsequence(small: string[], big: string[]) {
  const at: number[] = []
  let j = 0
  for (const key of small) {
    while (j < big.length && big[j] !== key) j++
    if (j === big.length) return null
    at.push(j++)
  }
  return at
}

type MergePick = ["ours" | "theirs", number]

/**
 * A run both sides changed. When one side only *added* blocks around the
 * base's, its additions are kept in place around the other side's version of
 * those blocks — the common case of an agent inserting a diagram next to a
 * paragraph the person is retyping. Otherwise ours comes first, then
 * whatever of theirs ours does not already hold.
 */
export function resolveConflict(base: string[], ours: string[], theirs: string[]): MergePick[] {
  const interleave = (added: string[], kept: string[], addedSide: MergePick[0], keptSide: MergePick[0], at: number[]) => {
    const out: MergePick[] = []
    let next = 0
    for (let j = 0; j < added.length; j++) {
      if (next < base.length && at[next] === j) {
        if (kept.length === base.length) out.push([keptSide, next])
        else if (next === 0) kept.forEach((_, i) => out.push([keptSide, i]))
        next++
      } else {
        out.push([addedSide, j])
      }
    }
    return out
  }
  if (base.length) {
    const inTheirs = subsequence(base, theirs)
    if (inTheirs) return interleave(theirs, ours, "theirs", "ours", inTheirs)
    const inOurs = subsequence(base, ours)
    if (inOurs) return interleave(ours, theirs, "ours", "theirs", inOurs)
  }
  const held = new Set(ours)
  return [
    ...ours.map((_, i): MergePick => ["ours", i]),
    ...theirs.flatMap((key, i): MergePick[] => (held.has(key) ? [] : [["theirs", i]])),
  ]
}

function sameKeys(a: string[], b: string[]) {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

/**
 * A block-level three-way merge: `ours` and `theirs` both started from
 * `base`, and every block only one side changed takes that side's version.
 *
 * Where both changed the same run of blocks differently nothing is thrown
 * away — ours comes first, then whatever of theirs ours does not already
 * hold. A note with a paragraph twice is a note the person can fix; a note
 * with the paragraph gone is not.
 */
export function mergeNotes(base: string, ours: string, theirs: string): string {
  if (ours === theirs || theirs === base) return ours
  if (ours === base) return theirs
  const b = splitBlocks(base)
  const o = splitBlocks(ours)
  const t = splitBlocks(theirs)
  const bk = b.map(blockKey)
  const ok = o.map(blockKey)
  const tk = t.map(blockKey)
  const toOurs = new Map(lcs(bk, ok))
  const toTheirs = new Map(lcs(bk, tk))
  const out: string[] = []
  let bi = 0
  let oi = 0
  let ti = 0
  while (true) {
    let anchor = bi
    while (anchor < b.length && !(toOurs.has(anchor) && toTheirs.has(anchor))) anchor++
    const oEnd = anchor < b.length ? toOurs.get(anchor)! : o.length
    const tEnd = anchor < b.length ? toTheirs.get(anchor)! : t.length
    const baseRun = bk.slice(bi, anchor)
    const oursRun = ok.slice(oi, oEnd)
    const theirsRun = tk.slice(ti, tEnd)
    const oursBlocks = o.slice(oi, oEnd).map((block) => block.text)
    const theirsBlocks = t.slice(ti, tEnd).map((block) => block.text)
    if (sameKeys(oursRun, baseRun)) out.push(...theirsBlocks)
    else if (sameKeys(theirsRun, baseRun) || sameKeys(oursRun, theirsRun)) out.push(...oursBlocks)
    else {
      for (const [side, index] of resolveConflict(baseRun, oursRun, theirsRun)) {
        out.push(side === "ours" ? oursBlocks[index] : theirsBlocks[index])
      }
    }
    if (anchor >= b.length) break
    // Both kept this block; ours carries the spelling the person last saw.
    out.push(o[oEnd].text)
    bi = anchor + 1
    oi = oEnd + 1
    ti = tEnd + 1
  }
  return `${out.join("\n\n")}\n`
}

/** One line per block for an agent: id, type and the block's markdown. */
export function describeBlocks(blocks: NoteBlock[], maxChars = 60_000) {
  let used = 0
  const rows: { id: string; type: string; markdown: string }[] = []
  let omitted = 0
  for (const block of blocks) {
    const type = block.type === "heading" ? `h${block.detail}` : block.detail ? `${block.type}:${block.detail}` : block.type
    if (used + block.text.length > maxChars) {
      omitted++
      continue
    }
    used += block.text.length
    rows.push({ id: block.id, type, markdown: block.text })
  }
  return { blocks: rows, ...(omitted ? { omitted } : null) }
}
