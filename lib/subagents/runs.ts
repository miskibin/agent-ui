import "server-only"

import { randomBytes } from "node:crypto"

import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import {
  applyStreamEvent,
  deriveSessionTitle,
  newId,
  seedAssistantMessage,
} from "@/lib/message-stream"
import { getProvider, listProviders } from "@/lib/providers/registry"
import { createSession, getSession } from "@/lib/store/sessions"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"
import type {
  SubagentBusEvent,
  SubagentRunSummary,
} from "@/lib/subagents/types"

export type {
  SubagentBusEvent,
  SubagentRunSummary,
  SubagentStatus,
} from "@/lib/subagents/types"

/**
 * Subagent runs: turns the app starts on its own, on an agent's behalf,
 * rather than because the user pressed send.
 *
 * A run is an ordinary turn of an ordinary chat. It is driven through this
 * server's own `POST /api/chat` — the identical request the page makes — so
 * persistence, the handoff journal, background-process tracking and memory
 * context all behave exactly as they do for a turn the user typed, and none of
 * it is written twice. What this module adds is the part a page normally
 * holds: it reads the SSE answer, keeps every frame, and fans them out — to
 * the agent waiting on the result (`/api/mcp`), and to the page, which
 * replays them into the chat through the same reducer it streams any turn
 * with (`/api/subagents/<id>/stream`).
 *
 * The registry is in memory, on `globalThis` so a dev-server reload keeps it.
 * The chats themselves are on disk; only the in-flight bookkeeping is not.
 */

type Listener = (frame: string | null) => void

type Run = SubagentRunSummary & {
  /** Every SSE `data:` payload the chat route sent, in order. */
  frames: string[]
  assistant: StoredMessage
  listeners: Set<Listener>
  abort: AbortController
  settled: Promise<void>
}

const MAX_FINISHED = 50
const MAX_FRAMES = 20_000

const globalState = globalThis as typeof globalThis & {
  __agentUiSubagents?: {
    runs: Map<string, Run>
    watchers: Set<(event: SubagentBusEvent) => void>
  }
}
const store = (globalState.__agentUiSubagents ??= {
  runs: new Map(),
  watchers: new Set(),
})

function summary(run: Run): SubagentRunSummary {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    ...(run.parentId ? { parentId: run.parentId } : null),
    harness: run.harness,
    model: run.model,
    title: run.title,
    prompt: run.prompt,
    ...(run.cwd ? { cwd: run.cwd } : null),
    status: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : null),
    userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId,
    ...(run.error ? { error: run.error } : null),
  }
}

function publish(event: SubagentBusEvent) {
  for (const watch of store.watchers) {
    try {
      watch(event)
    } catch {
      /* one broken watcher must not starve the others */
    }
  }
}

/** The page's subscription: every run that starts or ends from now on. */
export function watchSubagents(watch: (event: SubagentBusEvent) => void) {
  store.watchers.add(watch)
  return () => {
    store.watchers.delete(watch)
  }
}

export function activeRuns(): SubagentRunSummary[] {
  return [...store.runs.values()]
    .filter((run) => run.status === "running")
    .map(summary)
}

export function listRuns(parentId?: string): SubagentRunSummary[] {
  return [...store.runs.values()]
    .filter((run) => parentId === undefined || run.parentId === parentId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(summary)
}

/**
 * A run's frames so far plus a live feed of the rest. `null` on the feed is
 * the end of the run. The snapshot and the subscription are taken together,
 * so no frame lands between them.
 */
export function subscribeRun(
  runId: string,
  listener: Listener
): { frames: string[]; done: boolean; unsubscribe: () => void } | null {
  const run = store.runs.get(runId)
  if (!run) return null
  const done = run.status !== "running"
  if (!done) run.listeners.add(listener)
  return {
    frames: [...run.frames],
    done,
    unsubscribe: () => {
      run.listeners.delete(listener)
    },
  }
}

/** The answer a subagent gave: its last text block, which follows its tool calls. */
function finalAnswer(message: StoredMessage): string {
  const parts = message.parts ?? []
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part?.type === "text" && part.text.trim()) return part.text.trim()
  }
  return message.content.trim()
}

/** What an agent polling a run is told about it. */
export function describeRun(runId: string): Record<string, unknown> {
  const run = store.runs.get(runId)
  if (!run) throw new Error(`No subagent run "${runId}" (runs are forgotten when the app restarts).`)
  const tools = run.assistant.tools ?? []
  const base: Record<string, unknown> = {
    run_id: run.runId,
    session_id: run.sessionId,
    harness: run.harness,
    model: run.model,
    title: run.title,
    status: run.status,
    elapsed_seconds: Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000),
    tool_calls: tools.length,
  }
  if (run.status === "running") {
    const partial = run.assistant.content.trim()
    return {
      ...base,
      ...(partial ? { latest_output: partial.slice(-1500) } : null),
      note: "Still running. Call get_subagent again with wait_seconds to wait for it.",
    }
  }
  return {
    ...base,
    answer: finalAnswer(run.assistant),
    ...(run.error ? { error: run.error } : null),
  }
}

export async function waitForRun(runId: string, seconds: number): Promise<void> {
  const run = store.runs.get(runId)
  if (!run || run.status !== "running" || seconds <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    run.settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, seconds * 1000)
    }),
  ])
  clearTimeout(timer)
}

export function cancelRun(runId: string): boolean {
  const run = store.runs.get(runId)
  if (!run || run.status !== "running") return false
  run.abort.abort()
  return true
}

export async function harnessList(): Promise<Record<string, unknown>[]> {
  const infos = await listProviders()
  return infos.map((info) => ({
    id: info.id,
    name: info.name,
    available: info.available,
    ...(info.unavailableReason ? { unavailable_reason: info.unavailableReason } : null),
    tools: info.capabilities.tools,
  }))
}

export async function harnessModels(harness: string) {
  const provider = await getProvider(harness)
  if (!provider) throw new Error(`Unknown or disabled harness "${harness}".`)
  const models = await provider.listModels()
  return models
    .filter((model) => !model.disabled)
    .map((model) => ({ id: model.id, name: model.name }))
}

function prune() {
  const finished = [...store.runs.values()]
    .filter((run) => run.status !== "running")
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
  for (const run of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
    store.runs.delete(run.runId)
  }
}

export type StartRunInput = {
  /** This server's own origin — the run is a request to its `/api/chat`. */
  origin: string
  harness: string
  prompt: string
  model?: string
  cwd?: string
  title?: string
  /** Continue this subagent chat rather than starting a new one. */
  sessionId?: string
  parentId?: string
  permissionMode?: string
}

export async function startRun(input: StartRunInput): Promise<SubagentRunSummary> {
  const provider = await getProvider(input.harness)
  if (!provider) {
    const ids = (await listProviders()).filter((p) => p.available).map((p) => p.id)
    throw new Error(
      `Unknown or disabled harness "${input.harness}". Available: ${ids.join(", ") || "none"}.`
    )
  }
  const info = await provider.info()
  if (!info.available) {
    throw new Error(info.unavailableReason ?? `${info.name} is unavailable.`)
  }

  const parent = input.parentId ? await getSession(input.parentId) : null
  let session: SessionMeta | null = null
  if (input.sessionId) {
    session = await getSession(input.sessionId)
    if (!session) throw new Error(`No chat "${input.sessionId}" to continue.`)
    const busy = [...store.runs.values()].some(
      (run) => run.sessionId === session!.id && run.status === "running"
    )
    if (busy) throw new Error("That subagent is still running — wait for it first.")
  }

  let model = input.model ?? (session?.providerId === input.harness ? session.model : "")
  if (!model) {
    const models = await provider.listModels().catch(() => [])
    model = models.find((option) => !option.disabled)?.id ?? ""
  }
  const cwd = input.cwd ?? session?.cwd ?? parent?.cwd

  if (!session) {
    session = await createSession({
      title: input.title ?? deriveSessionTitle(input.prompt),
      providerId: input.harness,
      model,
      cwd,
      gitBranch: parent?.cwd === cwd ? parent?.gitBranch : undefined,
      permissionMode: input.permissionMode,
      parentId: parent?.id,
    })
  }

  let settle!: () => void
  const run: Run = {
    // Unguessable: a run id is all `/api/subagents/<id>/stream` asks for.
    runId: `r${randomBytes(9).toString("base64url")}`,
    sessionId: session.id,
    ...(parent ? { parentId: parent.id } : null),
    harness: input.harness,
    model,
    title: session.title,
    prompt: input.prompt,
    ...(cwd ? { cwd } : null),
    status: "running",
    startedAt: Date.now(),
    userMessageId: newId(),
    assistantMessageId: newId(),
    frames: [],
    assistant: seedAssistantMessage(""),
    listeners: new Set(),
    abort: new AbortController(),
    settled: new Promise<void>((resolve) => {
      settle = resolve
    }),
  }
  run.assistant = seedAssistantMessage(run.assistantMessageId)
  store.runs.set(run.runId, run)
  publish({ type: "run-started", run: summary(run), session })

  void pump(run, input, settle)
  return summary(run)
}

function emit(run: Run, frame: string) {
  if (run.frames.length < MAX_FRAMES) run.frames.push(frame)
  for (const listener of run.listeners) listener(frame)
}

function absorb(run: Run, data: string) {
  let parsed: { type?: string } | null = null
  try {
    parsed = JSON.parse(data) as { type?: string }
  } catch {
    return
  }
  emit(run, data)
  if (!parsed || parsed.type === "turn-state") return
  const event = parsed as AgentStreamEvent
  if (event.type === "error") run.error = event.message
  else run.assistant = applyStreamEvent(run.assistant, event)
}

async function pump(run: Run, input: StartRunInput, settle: () => void) {
  try {
    const res = await fetch(new URL("/api/chat", input.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: input.prompt,
        providerId: input.harness,
        model: run.model,
        sessionId: run.sessionId,
        cwd: run.cwd,
        permissionMode: input.permissionMode,
        userMessageId: run.userMessageId,
        assistantMessageId: run.assistantMessageId,
        subagentOf: run.parentId ?? "external",
      }),
      signal: run.abort.signal,
    })
    if (!res.ok || !res.body) {
      let message = `The chat route answered ${res.status}`
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) message = body.error
      } catch {
        /* keep the status line */
      }
      absorb(run, JSON.stringify({ type: "error", message }))
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let lines: string[] = []
    const flushEvent = () => {
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim()
      lines = []
      if (data && data !== "[DONE]") absorb(run, data)
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        if (line) lines.push(line)
        else flushEvent()
        newline = buffer.indexOf("\n")
      }
    }
    if (buffer.trim()) lines.push(buffer.trim())
    flushEvent()
  } catch (err) {
    if (!run.abort.signal.aborted) {
      absorb(
        run,
        JSON.stringify({
          type: "error",
          message: err instanceof Error ? err.message : "The subagent run failed",
        })
      )
    }
  } finally {
    run.status = run.abort.signal.aborted ? "cancelled" : run.error ? "error" : "done"
    run.finishedAt = Date.now()
    for (const listener of run.listeners) listener(null)
    run.listeners.clear()
    settle()
    publish({ type: "run-ended", run: summary(run) })
    prune()
  }
}
