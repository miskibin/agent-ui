import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

const dir = await mkdtemp(join(tmpdir(), "agent-ui-store-benchmark-"))
process.env.AGENT_UI_DIR = dir
try {
  const { createSession, readMessages, upsertMessages, writeMessages } = await import("@/lib/store/sessions")
  const chats = await Promise.all(Array.from({ length: 4 }, (_, i) => createSession({ title: `Benchmark ${i}` })))
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    id: `row-${i}`, sender: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    content: "A representative message with some text. ".repeat(20),
  }))
  await Promise.all(chats.map((chat) => writeMessages(chat.id, rows)))
  const samples: number[] = []
  for (let run = 0; run < 5; run++) {
    const start = performance.now()
    await Promise.all(chats.map((chat, i) => upsertMessages(chat.id, [
      { id: `run-${run}`, sender: "user", content: `Message ${i}` },
    ])))
    samples.push(performance.now() - start)
  }
  for (const chat of chats) {
    if ((await readMessages(chat.id)).length !== rows.length + 5) throw new Error("lost messages")
  }
  samples.sort((a, b) => a - b)
  console.log(JSON.stringify({ chats: chats.length, rowsPerChat: rows.length, batches: samples.length, medianMs: +samples[2].toFixed(1), maxMs: +samples[4].toFixed(1) }, null, 2))
} finally {
  await rm(dir, { recursive: true, force: true })
}
