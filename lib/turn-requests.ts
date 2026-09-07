/**
 * A running turn that needs an answer from the user before it can continue.
 *
 * Some harnesses block mid-turn: an ACP agent's `session/request_permission`
 * stops the subprocess until the client replies, and a CLI can do the same on
 * stdin. The browser's only way to talk back while a POST is still streaming
 * is a *second* request, so this module is the meeting point between the two:
 * the provider parks a promise here, the SSE stream tells the page what is
 * being asked, and `POST /api/chat/respond` resolves it.
 *
 * The wire protocol is deliberately unchanged. `AgentStreamEvent` grows no
 * variant — a waiting provider emits an ordinary `tool` event whose `input` is
 * the `UserRequest` itself, named `permission` or `question`, and re-emits the
 * same tool id with the outcome once it is answered. `parseUserRequestInput`
 * and `isOpenUserRequestTool` are the shared definition of that shape, which
 * is why this file imports nothing from `node:` — the browser reads it too.
 */

export type UserRequestOption = {
  id: string
  label: string
  /**
   * The backend's own word for what the option does. ACP's permission kinds
   * (`allow_once`, `allow_always`, `reject_once`, `reject_always`) travel
   * through here so the form can mark the affirmative ones as recommended.
   */
  kind?: string
  description?: string
}

export type UserRequestKind = "permission" | "select" | "confirm" | "input"

export type UserRequest = {
  /** Minted by the provider, unique within the turn. */
  id: string
  kind: UserRequestKind
  title: string
  description?: string
  /** permission / select / confirm. */
  options?: UserRequestOption[]
  /** input. */
  placeholder?: string
  /** What the agent is about to do, when the request is about a tool call. */
  tool?: { name: string; input?: unknown }
}

export type UserRequestAnswer = {
  optionId?: string
  text?: string
  cancelled?: boolean
}

/**
 * Hands one request to the user and waits. Providers receive it through
 * `AgentRunOptions.askUser`; a run given none has no interactive channel and
 * must fall back to a policy.
 */
export type AskUser = (request: UserRequest) => Promise<UserRequestAnswer>

/** The `name` a waiting tool event carries, per kind. */
export function userRequestToolName(kind: UserRequestKind): string {
  return kind === "permission" ? "permission" : "question"
}

const USER_REQUEST_TOOL_NAMES = new Set(["permission", "question"])

/**
 * What a waiting row says while it waits. Short on purpose: the vendored tool
 * row shows an output under 28 characters inline in its headline, so the
 * collapsed row reads "Working · permission · Waiting for your answer" instead
 * of growing a body nobody asked for.
 */
export const USER_REQUEST_WAITING = "Waiting for your answer"

/* -------------------------------------------------------------------------- */
/*                        the tool-event shape, shared                        */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

const KINDS: UserRequestKind[] = ["permission", "select", "confirm", "input"]

function parseOptions(value: unknown): UserRequestOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: UserRequestOption[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record) continue
    const id = asText(record.id)
    const label = asText(record.label)
    if (!id || !label) continue
    out.push({
      id,
      label,
      ...(asText(record.kind) ? { kind: record.kind as string } : null),
      ...(asText(record.description)
        ? { description: record.description as string }
        : null),
    })
  }
  return out.length ? out : undefined
}

/**
 * Reads a `UserRequest` back out of a tool event's `input`. Returns null for
 * anything that is not one — an ordinary tool whose args happen to be JSON has
 * no `requestId`, and a half-streamed string does not parse.
 */
export function parseUserRequestInput(input?: string): UserRequest | null {
  if (!input?.trim()) return null
  let record: Record<string, unknown> | null
  try {
    record = asRecord(JSON.parse(input) as unknown)
  } catch {
    return null
  }
  if (!record) return null
  // `requestId` is the field the answer is posted with; `id` is accepted so a
  // request can be round-tripped through its own serialization.
  const id = asText(record.requestId) ?? asText(record.id)
  const title = asText(record.title)
  const kind = KINDS.find((candidate) => candidate === record.kind)
  if (!id || !title || !kind) return null
  const tool = asRecord(record.tool)
  const toolName = tool ? asText(tool.name) : undefined
  const options = parseOptions(record.options)
  const description = asText(record.description)
  const placeholder = asText(record.placeholder)
  return {
    id,
    kind,
    title,
    ...(description ? { description } : null),
    ...(options ? { options } : null),
    ...(placeholder ? { placeholder } : null),
    ...(toolName ? { tool: { name: toolName, input: tool!.input } } : null),
  }
}

/** The `input` string a waiting provider puts on its tool event. */
export function formatUserRequestInput(request: UserRequest): string {
  const { id, ...rest } = request
  return JSON.stringify({ requestId: id, ...rest })
}

/**
 * A `permission`/`question` tool row still waiting on the user — the one the
 * page lifts into a form above the composer. Status and shape both have to
 * hold: a row whose input never parsed would render nothing.
 */
export function isOpenUserRequestTool(tool: {
  name: string
  status?: string
  input?: string
}): boolean {
  if (!USER_REQUEST_TOOL_NAMES.has(tool.name.trim().toLowerCase())) return false
  if (tool.status !== "running" && tool.status !== "pending") return false
  return parseUserRequestInput(tool.input) !== null
}

/* -------------------------------------------------------------------------- */
/*                                the registry                                */
/* -------------------------------------------------------------------------- */

type PendingRequest = {
  sessionId: string
  request: UserRequest
  createdAt: number
  settle: (answer: UserRequestAnswer) => void
}

/**
 * In-memory and deliberately so: a parked promise cannot outlive the process
 * that holds it, and the turn dies with the server anyway. Keyed by chat *and*
 * request id so two chats can wait at once without colliding.
 */
const pending = new Map<string, PendingRequest>()

function keyOf(sessionId: string, requestId: string) {
  return `${sessionId}:${requestId}`
}

/**
 * The `AskUser` one turn hands its provider. Registering, awaiting and
 * cleaning up are all one closure so there is no way to leave an entry behind:
 * an answer, an abort and a duplicate id all remove it.
 *
 * Abort resolves `{ cancelled: true }` rather than rejecting — a provider that
 * is blocked on the user needs to unwind its own protocol (answer the agent's
 * JSON-RPC request, close the session) and a rejection would skip that.
 */
export function createAskUser({
  sessionId,
  signal,
}: {
  sessionId: string
  signal?: AbortSignal
}): AskUser {
  return (request) =>
    new Promise<UserRequestAnswer>((resolve) => {
      if (signal?.aborted) {
        resolve({ cancelled: true })
        return
      }
      const key = keyOf(sessionId, request.id)
      // A provider that reuses an id would otherwise strand the first waiter.
      pending.get(key)?.settle({ cancelled: true })

      let settled = false
      const settle = (answer: UserRequestAnswer) => {
        if (settled) return
        settled = true
        if (pending.get(key)?.settle === settle) pending.delete(key)
        signal?.removeEventListener("abort", onAbort)
        resolve(answer)
      }
      function onAbort() {
        settle({ cancelled: true })
      }

      pending.set(key, { sessionId, request, createdAt: Date.now(), settle })
      signal?.addEventListener("abort", onAbort)
    })
}

/** Resolves one waiting request. False when nothing is waiting under that id. */
export function answerUserRequest(
  sessionId: string,
  requestId: string,
  answer: UserRequestAnswer
): boolean {
  const entry = pending.get(keyOf(sessionId, requestId))
  if (!entry) return false
  entry.settle(answer)
  return true
}

/** What is waiting right now — for the respond route's 404, and for tests. */
export function listUserRequests(
  sessionId?: string
): Array<{ sessionId: string; request: UserRequest; createdAt: number }> {
  const out: Array<{ sessionId: string; request: UserRequest; createdAt: number }> = []
  for (const entry of pending.values()) {
    if (sessionId !== undefined && entry.sessionId !== sessionId) continue
    out.push({
      sessionId: entry.sessionId,
      request: entry.request,
      createdAt: entry.createdAt,
    })
  }
  return out
}

/** Reads one waiting request without answering it. */
export function getUserRequest(
  sessionId: string,
  requestId: string
): UserRequest | null {
  return pending.get(keyOf(sessionId, requestId))?.request ?? null
}

/** Validates an answer coming off the wire — the route hands it straight on. */
export function sanitizeUserRequestAnswer(input: unknown): UserRequestAnswer | null {
  const record = asRecord(input)
  if (!record) return null
  const optionId = asText(record.optionId)
  const text = typeof record.text === "string" ? record.text : undefined
  const cancelled = record.cancelled === true
  if (!optionId && text === undefined && !cancelled) return null
  return {
    ...(optionId ? { optionId } : null),
    ...(text === undefined ? null : { text }),
    ...(cancelled ? { cancelled: true } : null),
  }
}

/** The tool name a non-permission request is published under. */
export const USER_REQUEST_TOOL = userRequestToolName("select")
