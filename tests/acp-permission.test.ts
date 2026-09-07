import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { runAcpAgent, type AcpPermissionDecision } from "@/lib/acp-agent"
import type { AgentStreamEvent } from "@/lib/cursor-agent-types"
import {
  createAskUser,
  answerUserRequest,
  isOpenUserRequestTool,
  listUserRequests,
  parseUserRequestInput,
  type AskUser,
  type UserRequest,
} from "@/lib/turn-requests"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STUB = path.join(HERE, "stubs", "acp-permission-agent.mjs")

function spawnSpec(args: string[] = []) {
  return { command: STUB, args, cwd: HERE, env: {} }
}

/**
 * The provider's half, reduced to what the run actually needs: turn the ACP
 * options into a `UserRequest`, hand it to `ask`, and map the answer back.
 */
function askingHandlers(seq = { n: 0 }) {
  return {
    async readTextFile() {
      return ""
    },
    async writeTextFile() {},
    async decidePermission({
      toolCall,
      options,
      ask,
    }: {
      toolCall: { toolCallId?: string; title?: string; rawInput?: unknown }
      options: Array<{ optionId?: string; name?: string; kind?: string }>
      ask?: AskUser
    }): Promise<AcpPermissionDecision> {
      if (!ask) return { option: null, reason: "no channel" }
      const request: UserRequest = {
        id: `req-${++seq.n}`,
        kind: "permission",
        title: `Allow ${toolCall.title}?`,
        options: options.map((option) => ({
          id: option.optionId!,
          label: option.name!,
          kind: option.kind,
        })),
        tool: { name: toolCall.title!, input: toolCall.rawInput },
      }
      const answer = await ask(request)
      const picked = options.find((option) => option.optionId === answer.optionId)
      if (!picked) return { option: null, reason: "You did not allow it.", approved: false }
      const approved = picked.kind === "allow_once" || picked.kind === "allow_always"
      return { option: picked, approved, reason: approved ? "You allowed it." : "You refused it." }
    },
  }
}

/** Drains a run, answering the first request it publishes with `answer`. */
async function runAnswering(
  sessionId: string,
  answer: (request: UserRequest) => { optionId?: string; cancelled?: boolean },
  options: { images?: string[]; args?: string[] } = {}
) {
  const controller = new AbortController()
  const events: AgentStreamEvent[] = []
  const askUser = createAskUser({ sessionId, signal: controller.signal })

  const generator = runAcpAgent({
    spawn: spawnSpec(options.args),
    prompt: "write hello.txt",
    label: "stub",
    canWriteFiles: true,
    images: options.images,
    askUser,
    signal: controller.signal,
    handlers: askingHandlers(),
  })

  for await (const event of generator) {
    events.push(event)
    // The waiting row must reach the consumer *before* the answer does —
    // that is the whole point of pushing it ahead of the await.
    if (event.type === "tool" && isOpenUserRequestTool(event)) {
      const request = parseUserRequestInput(event.input)!
      assert.equal(listUserRequests(sessionId).length, 1)
      answerUserRequest(sessionId, request.id, answer(request))
    }
  }
  controller.abort()
  return events
}

const tools = (events: AgentStreamEvent[]) =>
  events.filter((event) => event.type === "tool")
const text = (events: AgentStreamEvent[]) =>
  events
    .filter((event) => event.type === "text")
    .map((event) => event.text)
    .join("")

test("a blocked permission reaches the user and the turn continues", async () => {
  const events = await runAnswering("acp-allow", () => ({ optionId: "allow" }))

  const rows = tools(events).filter((event) => event.name === "permission")
  assert.equal(rows.length, 2, "one waiting row, one outcome, same id")
  assert.equal(rows[0].id, rows[1].id)

  const waiting = rows[0]
  assert.equal(waiting.status, "running")
  assert.equal(waiting.output, "Waiting for your answer")
  const request = parseUserRequestInput(waiting.input)
  assert.equal(request?.kind, "permission")
  assert.equal(request?.title, "Allow write_file?")
  assert.deepEqual(
    request?.options?.map((option) => option.kind),
    ["allow_once", "allow_always", "reject_once"]
  )
  assert.deepEqual(request?.tool, { name: "write_file", input: { path: "hello.txt", content: "hi" } })

  assert.equal(rows[1].status, "done")
  assert.equal(rows[1].output, "You allowed it.")
  // The outcome carries no input, so the stored row keeps the request it had.
  assert.equal(rows[1].input, undefined)

  // The agent got the option id back and finished its turn.
  assert.match(text(events), /permission=allow /)
  assert.ok(events.some((event) => event.type === "done"))
})

test("a refusal selects the agent's own reject option and marks the row", async () => {
  const events = await runAnswering("acp-deny", () => ({ optionId: "deny" }))
  const rows = tools(events).filter((event) => event.name === "permission")
  assert.equal(rows[1].status, "error")
  assert.equal(rows[1].output, "You refused it.")
  assert.match(text(events), /permission=deny /)
})

test("cancelling answers the agent without selecting anything", async () => {
  const events = await runAnswering("acp-cancel", () => ({ cancelled: true }))
  const rows = tools(events).filter((event) => event.name === "permission")
  assert.equal(rows[1].status, "error")
  assert.equal(rows[1].output, "You did not allow it.")
  // No allow option was named, so the client falls back to a rejecting one.
  assert.match(text(events), /permission=deny /)
})

test("images ride along only when the agent advertises them", async () => {
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

  const withImages = await runAnswering(
    "acp-vision",
    () => ({ optionId: "allow" }),
    { images: [pixel] }
  )
  assert.match(text(withImages), /prompt=text,image:image\/png/)

  const without = await runAnswering(
    "acp-no-vision",
    () => ({ optionId: "allow" }),
    { images: [pixel], args: ["--no-images"] }
  )
  assert.match(text(without), /prompt=text$/)
})

test("a run with no channel refuses rather than widening the policy", async () => {
  const controller = new AbortController()
  const events: AgentStreamEvent[] = []
  for await (const event of runAcpAgent({
    spawn: spawnSpec(),
    prompt: "write hello.txt",
    label: "stub",
    canWriteFiles: true,
    signal: controller.signal,
    handlers: askingHandlers(),
  })) {
    events.push(event)
  }
  controller.abort()
  const rows = tools(events).filter((event) => event.name === "permission")
  assert.equal(rows.length, 1, "nothing was published for the user to answer")
  assert.equal(rows[0].status, "error")
  assert.equal(rows[0].output, "no channel")
  assert.match(text(events), /permission=deny /)
})
