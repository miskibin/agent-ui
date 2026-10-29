import "server-only"

import { randomBytes } from "node:crypto"
import { resolveSubagentDefaults, subagentPermission, type SubagentDefaults } from "@/lib/subagents/defaults"
import { createWorktree } from "@/lib/worktree"
import { runGit } from "@/lib/git-exec"

import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import {
  applyStreamEvent,
  deriveSessionTitle,
  newId,
  seedAssistantMessage,
} from "@/lib/message-stream"
import { getProvider, listProviders } from "@/lib/providers/registry"
import { createSession, getSession, readMessages } from "@/lib/store/sessions"
import type { SessionMeta, StoredMessage } from "@/lib/store/types"
import {
  createProgress,
  digestProgress,
  finishProgress,
  trackEvent,
  type RunProgress,
} from "@/lib/subagents/progress"
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
  effort?: string
  /** Every SSE `data:` payload the chat route sent, in order. */
  frames: string[]
  assistant: StoredMessage
  listeners: Set<Listener>
  abort: AbortController
  settled: Promise<void>
  settle: () => void
  /** The stream folded into counters — what an orchestrator is told. */
  progress: RunProgress
  /** Set when `timeout_seconds` ran out; the run ends as an error, not a cancel. */
  timedOut?: number
}

/** How much of a run a description carries — `lib/subagents/mcp`'s `ViewArgs`. */
export type RunView = {
  detail?: "brief" | "full"
  sinceStep?: number
  maxAnswerChars?: number
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

/** `list_subagents`: one compact row per run, the digest's counters only. */
export function listRunRows(parentId?: string): Record<string, unknown>[] {
  const now = Date.now()
  return [...store.runs.values()]
    .filter((run) => parentId === undefined || run.parentId === parentId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((run) => ({
      run_id: run.runId,
      session_id: run.sessionId,
      harness: run.harness,
      title: run.title,
      status: run.status,
      phase: run.progress.phase,
      steps: run.progress.stepCount,
      ...(run.progress.edited.size ? { files_edited: run.progress.edited.size } : null),
      ...(run.progress.waiting ? { waiting_on_user: true } : null),
      elapsed_seconds:
        run.status === "queued" ? 0 : seconds(run.startedAt, run.finishedAt ?? now),
    }))
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

/** The answer, capped — the tail is cut, since a report leads with its point. */
function cappedAnswer(answer: string, max = 4000): Record<string, unknown> {
  if (!answer) return {}
  if (answer.length <= max) return { answer }
  return {
    answer: `${answer.slice(0, max)}…`,
    answer_truncated: { shown: max, total: answer.length },
  }
}

function seconds(from: number, to: number) {
  return Math.max(0, Math.round((to - from) / 1000))
}

function describe(run: Run, view: RunView = {}): Record<string, unknown> {
  const now = Date.now()
  const finished = run.status !== "running" && run.status !== "queued"
  return {
    run_id: run.runId,
    session_id: run.sessionId,
    harness: run.harness,
    ...(run.model ? { model: run.model } : null),
    title: run.title,
    status: run.status,
    elapsed_seconds:
      run.status === "queued" ? 0 : seconds(run.startedAt, run.finishedAt ?? now),
    ...digestProgress(run.progress, now, {
      detail: view.detail,
      sinceStep: view.sinceStep,
      output: run.assistant.content,
    }),
    ...(finished ? cappedAnswer(finalAnswer(run.assistant), view.maxAnswerChars) : null),
    ...(run.error ? { error: run.error } : null),
  }
}

/** What an agent polling a run is told about it. */
export function describeRun(runId: string, view: RunView = {}): Record<string, unknown> {
  const run = store.runs.get(runId)
  if (!run) {
    throw new Error(
      `No subagent run "${runId}" — runs are forgotten when the app restarts. Pass session_id instead to read that chat's latest turn.`
    )
  }
  return describe(run, view)
}

/** The newest run on a chat, if this process still holds one. */
function latestRunFor(sessionId: string): Run | undefined {
  let latest: Run | undefined
  for (const run of store.runs.values()) {
    if (run.sessionId !== sessionId) continue
    if (!latest || run.startedAt >= latest.startedAt) latest = run
  }
  return latest
}

/**
 * A chat's latest turn read back from disk: what `get_subagent` answers for a
 * `session_id` when the registry no longer has a run for it — the app
 * restarted, or the run aged out. The digest is rebuilt from the stored tool
 * calls, so it says the same things a live one would, minus the timing.
 */
export async function describeSession(
  sessionId: string,
  view: RunView = {}
): Promise<Record<string, unknown>> {
  const live = latestRunFor(sessionId)
  if (live) return describe(live, view)
  const session = await getSession(sessionId)
  if (!session) throw new Error(`No chat "${sessionId}".`)
  const messages = await readMessages(sessionId)
  const last = [...messages].reverse().find((message) => message.sender === "assistant")
  const base = {
    session_id: sessionId,
    harness: session.providerId,
    ...(session.model ? { model: session.model } : null),
    title: session.title,
  }
  if (!last) return { ...base, status: "idle", note: "This chat has no answer yet." }
  const at = last.createdAt ?? session.updatedAt
  const progress = createProgress(at)
  for (const tool of last.tools ?? []) {
    const status = tool.status === "error" ? "error" : "done"
    trackEvent(
      progress,
      {
        type: "tool",
        id: tool.id,
        name: tool.name,
        status,
        ...(tool.input ? { input: tool.input } : null),
        ...(tool.output ? { output: tool.output } : null),
      },
      at
    )
  }
  finishProgress(progress, at)
  return {
    ...base,
    status: "done",
    note: "Read from the saved chat — the live run is no longer held, so timing and the step log's clock are not known.",
    ...digestProgress(progress, at, { detail: view.detail, sinceStep: view.sinceStep }),
    ...cappedAnswer(finalAnswer(last), view.maxAnswerChars),
  }
}

export async function waitForRun(runId: string, seconds: number): Promise<void> {
  await waitForRuns([runId], "any", seconds)
}

/**
 * Waits for the first (`any`) or the last (`all`) of these runs to finish, or
 * for `seconds`, whichever is sooner. Unknown ids and finished runs count as
 * finished, so an `any` over a list holding one returns at once.
 */
export async function waitForRuns(
  runIds: string[],
  mode: "any" | "all",
  seconds: number
): Promise<void> {
  const pending = runIds
    .map((id) => store.runs.get(id))
    .filter((run): run is Run => !!run && (run.status === "running" || run.status === "queued"))
  if (seconds <= 0 || pending.length === 0) return
  if (mode === "any" && pending.length < runIds.length) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = pending.map((run) => run.settled)
  await Promise.race([
    mode === "any" ? Promise.race(settled) : Promise.all(settled),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, seconds * 1000)
    }),
  ])
  clearTimeout(timer)
}

/** The runs a caller has in flight — what an empty `wait_subagents` waits on. */
export function inFlightRuns(parentId?: string): string[] {
  return [...store.runs.values()]
    .filter(
      (run) =>
        (run.status === "running" || run.status === "queued") &&
        (parentId === undefined || run.parentId === parentId)
    )
    .map((run) => run.runId)
}

export function cancelRun(runId: string): boolean {
  const run = store.runs.get(runId)
  if (!run) return false
  if (run.status === "queued") {
    // Never started: nothing to abort, and the page never heard of it.
    run.status = "cancelled"
    run.finishedAt = Date.now()
    finishProgress(run.progress, run.finishedAt)
    run.settle()
    return true
  }
  if (run.status !== "running") return false
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
    .filter((run) => run.status !== "running" && run.status !== "queued")
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
  for (const run of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
    store.runs.delete(run.runId)
  }
}

export type StartRunInput = {
  /** This server's own origin — the run is a request to its `/api/chat`. */
  origin: string
  harness?: string
  prompt: string
  model?: string
  effort?: string
  defaults?: SubagentDefaults
  isolation?: "shared" | "worktree"
  cwd?: string
  title?: string
  /** Continue this subagent chat rather than starting a new one. */
  sessionId?: string
  parentId?: string
  permissionMode?: string
  /** Stop the run after this many seconds; it ends as an error, work kept. */
  timeoutSeconds?: number
  /**
   * Queue behind this run of the same chat instead of refusing because the
   * chat is busy: the new run is `queued` until that one settles.
   */
  after?: string
}

export async function startRun(input: StartRunInput): Promise<SubagentRunSummary> {
  const parent = input.parentId ? await getSession(input.parentId) : null
  let session: SessionMeta | null = null
  if (input.sessionId) {
    session = await getSession(input.sessionId)
    if (!session) throw new Error(`No chat "${input.sessionId}" to continue.`)
    if (input.parentId && session.parentId !== input.parentId) throw new Error("That chat belongs to another orchestrator.")
    // A caller that named a run to queue behind has chosen to wait its turn;
    // the chain (`after` is always the newest) keeps the follow-ups in order.
    const busy =
      !input.after &&
      [...store.runs.values()].some(
        (run) =>
          run.sessionId === session!.id &&
          (run.status === "running" || run.status === "queued")
      )
    if (busy) {
      throw new Error(
        "That subagent is still running. Use message_subagent to queue a follow-up or interrupt it."
      )
    }
  }

  const resolved = resolveSubagentDefaults(input,
    session ? { harness: session.providerId, model: session.model } : undefined,
    { harness: input.defaults?.harness ?? parent?.providerId,
      model: input.defaults?.model ?? parent?.model, effort: input.defaults?.effort })
  const provider = await getProvider(resolved.harness)
  if (!provider) throw new Error(`Unknown or disabled harness "${resolved.harness}". Use list_harnesses for available ids.`)
  const info = await provider.info()
  if (!info.available) throw new Error(info.unavailableReason ?? `${info.name} is unavailable.`)
  const inheritedPermission = input.permissionMode ?? session?.permissionMode ?? parent?.permissionMode ?? info.capabilities.defaultPermissionMode
  const permissionMode = subagentPermission(inheritedPermission, info.capabilities)
  const effort = info.capabilities.effort ? resolved.effort : undefined
  input = { ...input, harness: resolved.harness, permissionMode, effort }
  let model = resolved.model ?? ""
  if (!model) {
    const models = await provider.listModels().catch(() => [])
    model = models.find((option) => !option.disabled)?.id ?? ""
  }
  let cwd = input.cwd ?? session?.cwd ?? parent?.cwd
  let worktree = session?.worktree ?? (cwd === parent?.cwd ? parent?.worktree : undefined)
  if (input.isolation === "worktree") {
    if (session) throw new Error("Worktree isolation is only available for a new subagent chat.")
    if (!cwd) throw new Error("Worktree isolation needs a working folder.")
    if (inheritedPermission === "read-only" || inheritedPermission === "plan") throw new Error("Creating a worktree requires write permission.")
    const head = await runGit(["rev-parse", "HEAD"], { cwd })
    if (!head.ok) throw new Error("Could not resolve HEAD for worktree isolation.")
    const branch = await runGit(["branch", "--show-current"], { cwd })
    const created = await createWorktree({ repoRoot: cwd, title: input.title ?? deriveSessionTitle(input.prompt),
      baseRef: head.stdout.trim(), baseBranch: branch.ok ? branch.stdout.trim() : "" })
    if (!created.ok) throw new Error(created.error)
    cwd = created.root
    worktree = { root: created.root, branch: created.branch, repoRoot: created.repoRoot, baseBranch: created.baseBranch }
  }

  if (!session) {
    session = await createSession({
      title: input.title ?? deriveSessionTitle(input.prompt),
      providerId: resolved.harness,
      model,
      cwd,
      gitBranch: worktree?.branch ?? (parent?.cwd === cwd ? parent?.gitBranch : undefined),
      worktree,
      permissionMode: input.permissionMode,
      parentId: parent?.id,
      // No chat here asked for it: the sidebar shelves it until it is adopted.
      external: !parent,
    })
  }

  const ahead = input.after ? store.runs.get(input.after) : undefined
  const queued = !!ahead && (ahead.status === "running" || ahead.status === "queued")
  let settle!: () => void
  const now = Date.now()
  const run: Run = {
    // Unguessable: a run id is all `/api/subagents/<id>/stream` asks for.
    runId: `r${randomBytes(9).toString("base64url")}`,
    sessionId: session.id,
    ...(parent ? { parentId: parent.id } : null),
    harness: resolved.harness,
    effort,
    model,
    title: session.title,
    prompt: input.prompt,
    ...(cwd ? { cwd } : null),
    status: queued ? "queued" : "running",
    startedAt: now,
    userMessageId: newId(),
    assistantMessageId: newId(),
    frames: [],
    assistant: seedAssistantMessage(""),
    listeners: new Set(),
    abort: new AbortController(),
    settled: new Promise<void>((resolve) => {
      settle = resolve
    }),
    settle: () => settle(),
    progress: createProgress(now, queued ? "queued" : "starting"),
  }
  run.assistant = seedAssistantMessage(run.assistantMessageId)
  store.runs.set(run.runId, run)

  const launch = () => {
    // Cancelled while it waited its turn: there is nothing to start.
    if (run.status === "cancelled") return
    run.status = "running"
    run.startedAt = Date.now()
    run.progress = createProgress(run.startedAt)
    publish({ type: "run-started", run: summary(run), session: session! })
    void pump(run, input, settle)
  }
  if (queued) void ahead.settled.then(launch)
  else launch()
  return summary(run)
}

export type MessageInput = {
  origin: string
  runId?: string
  sessionId?: string
  message: string
  interrupt: boolean
  parentId?: string
  permissionMode?: string
  timeoutSeconds?: number
  defaults?: SubagentDefaults
}

/**
 * A follow-up into a subagent's chat. Idle, it is simply the next turn; busy,
 * it either waits its turn (`queued`) or stops the turn in flight and goes now
 * — the stop is awaited, because the chat route is still writing the dying
 * turn's last frame until it settles.
 */
export async function messageSubagent(input: MessageInput): Promise<SubagentRunSummary> {
  const named = input.runId ? store.runs.get(input.runId) : undefined
  if (input.runId && !named && !input.sessionId) {
    throw new Error(
      `No subagent run "${input.runId}" — runs are forgotten when the app restarts. Pass session_id instead.`
    )
  }
  const sessionId = named?.sessionId ?? input.sessionId!
  const session = await getSession(sessionId)
  if (!session) throw new Error(`No chat "${sessionId}".`)
  if (input.parentId && session.parentId && session.parentId !== input.parentId) {
    throw new Error("That chat belongs to another orchestrator.")
  }

  // The newest unfinished run of the chat is what a follow-up lines up behind.
  const busy = [...store.runs.values()]
    .filter(
      (run) =>
        run.sessionId === sessionId && (run.status === "running" || run.status === "queued")
    )
    .sort((a, b) => b.startedAt - a.startedAt)
  let after: string | undefined
  if (busy.length && input.interrupt) {
    for (const run of busy) cancelRun(run.runId)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(busy.map((run) => run.settled)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 10_000)
      }),
    ])
    clearTimeout(timer)
  } else if (busy.length) {
    after = busy[0].runId
  }

  return startRun({
    origin: input.origin,
    harness: session.providerId,
    prompt: input.message,
    sessionId,
    parentId: input.parentId ?? session.parentId,
    permissionMode: input.permissionMode,
    defaults: input.defaults,
    effort: named?.effort,
    timeoutSeconds: input.timeoutSeconds,
    after,
  })
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
  trackEvent(run.progress, event, Date.now())
  if (event.type === "error") run.error = run.timedOut ? run.error : event.message
  else run.assistant = applyStreamEvent(run.assistant, event)
}

async function pump(run: Run, input: StartRunInput, settle: () => void) {
  const timeout = input.timeoutSeconds
    ? setTimeout(() => {
        run.timedOut = input.timeoutSeconds
        run.error = `Timed out after ${input.timeoutSeconds}s — stopped; its chat and partial work are kept.`
        run.abort.abort()
      }, input.timeoutSeconds * 1000)
    : undefined
  try {
    const res = await fetch(new URL("/api/chat", input.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: input.prompt,
        providerId: run.harness,
        model: run.model,
        effort: run.effort,
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
    if (!run.abort.signal.aborted && !run.timedOut) {
      absorb(
        run,
        JSON.stringify({
          type: "error",
          message: err instanceof Error ? err.message : "The subagent run failed",
        })
      )
    }
  } finally {
    clearTimeout(timeout)
    run.status = run.timedOut
      ? "error"
      : run.abort.signal.aborted
        ? "cancelled"
        : run.error
          ? "error"
          : "done"
    run.finishedAt = Date.now()
    finishProgress(run.progress, run.finishedAt)
    for (const listener of run.listeners) listener(null)
    run.listeners.clear()
    settle()
    publish({ type: "run-ended", run: summary(run) })
    prune()
  }
}
