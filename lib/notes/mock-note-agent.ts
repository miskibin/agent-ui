import type { AgentStreamEvent, McpServerConfig } from "@/lib/providers/types"

/**
 * The mock harness, working in a note: it does what a real agent does there
 * — reads the blocks through the bridge, plants a pending placeholder after
 * the selected words, then fills it — so the whole note flow can be run and
 * tested with nothing installed. It talks to the same `/api/mcp?note=` tools
 * a real harness gets, so the guard, the live update and the thread reply
 * are the real ones.
 */

type Block = { id: string; type: string; markdown: string }

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }, { once: true })
  })
}

/** The note bridge this turn was handed, when it was handed one. */
export function noteBridge(servers: McpServerConfig[] | undefined) {
  return servers?.find((server) => {
    try {
      return new URL(server.url).searchParams.has("note")
    } catch {
      return false
    }
  })
}

function selectedWords(prompt: string) {
  const match = /The selected words:\n"""\n([\s\S]*?)\n"""/.exec(prompt)
  return match?.[1] ?? ""
}

function instruction(prompt: string) {
  const match = /asked(?: about the note "[^"]*")?:\n\n([\s\S]*?)\n\n(?:The selected words:|Earlier in this thread:|How to work:)/.exec(prompt)
  return (match?.[1] ?? prompt).trim()
}

function contentFor(ask: string, words: string) {
  if (/diagram|mermaid|flow|schemat|diagram|przepływ|wykres/i.test(ask)) {
    const label = words.split(/\s+/).slice(0, 3).join(" ").replace(/["[\]]/g, "") || "Start"
    return [
      "```mermaid",
      "flowchart LR",
      `  A["${label}"] --> B[Process]`,
      "  B --> C{OK?}",
      "  C -->|yes| D[Done]",
      "  C -->|no| B",
      "```",
    ].join("\n")
  }
  if (/table|tabel/i.test(ask)) {
    return "| Item | Note |\n| --- | --- |\n| First | Drafted by the mock agent |\n| Second | Edit me |"
  }
  return `> ${ask} — the mock agent's take on "${words.slice(0, 60)}".`
}

export async function* runMockNoteAgent(input: {
  prompt: string
  bridge: McpServerConfig
  signal?: AbortSignal
}): AsyncGenerator<AgentStreamEvent> {
  let rpcId = 0
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(input.bridge.url, {
      method: "POST",
      headers: { ...input.bridge.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      signal: input.signal,
    })
    const message = (await res.json()) as {
      result?: { content?: { text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
      error?: { message?: string }
    }
    if (message.error) throw new Error(message.error.message ?? "Bridge error")
    const text = message.result?.content?.map((part) => part.text ?? "").join("") ?? ""
    return { text, data: message.result?.structuredContent, isError: !!message.result?.isError }
  }

  const ask = instruction(input.prompt)
  const words = selectedWords(input.prompt)
  yield { type: "thinking", text: `The person wants: ${ask}. I'll read the note, then write it after the selected words.` }

  yield { type: "tool", id: "read", name: "note_read", status: "running", input: "{}" }
  const read = await call("note_read", {})
  yield { type: "tool", id: "read", name: "note_read", status: read.isError ? "error" : "done", output: read.text.slice(0, 2000) }
  if (read.isError) {
    yield { type: "text", text: "I could not read the note." }
    return
  }
  const blocks = ((read.data?.blocks as Block[] | undefined) ?? [])
  const needle = words.split("\n")[0].trim().slice(0, 40)
  const target = blocks.find((block) => needle && block.markdown.includes(needle)) ?? blocks.at(-1)
  const after = target?.id ?? "end"

  const plant = { ops: [{ op: "pending", after, intent: `Writing: ${ask}` }] }
  yield { type: "tool", id: "plant", name: "note_edit", status: "running", input: JSON.stringify(plant) }
  const planted = await call("note_edit", plant)
  yield { type: "tool", id: "plant", name: "note_edit", status: planted.isError ? "error" : "done", output: planted.text }
  if (planted.isError) {
    yield { type: "text", text: planted.text }
    return
  }
  const pendingId = (planted.data?.pending as string[] | undefined)?.[0]
  await sleep(1200, input.signal)

  const fill = { ops: [{ op: "replace", id: pendingId, markdown: contentFor(ask, words) }] }
  yield { type: "tool", id: "fill", name: "note_edit", status: "running", input: JSON.stringify(fill) }
  const filled = await call("note_edit", fill)
  yield { type: "tool", id: "fill", name: "note_edit", status: filled.isError ? "error" : "done", output: filled.text }
  yield {
    type: "text",
    text: filled.isError ? `The placeholder moved before I could fill it: ${filled.text}` : "Added it right after the selected paragraph.",
  }
  yield { type: "done" }
}
