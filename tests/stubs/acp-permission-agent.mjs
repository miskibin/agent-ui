/**
 * A minimal ACP agent that does exactly one thing: ask for permission.
 *
 * It exists so `runAcpAgent`'s half of the interactive approval can be tested
 * without a model, an API key or a network — spawn it, run one turn, and watch
 * the client publish a waiting row, park on `askUser`, and answer the blocked
 * JSON-RPC request with whatever comes back.
 *
 * Knobs, via argv: `--no-images` drops `promptCapabilities.image` from the
 * handshake so the vision path can be tested from both sides.
 */

const images = !process.argv.includes("--no-images")

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let index = buffer.indexOf("\n")
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(JSON.parse(line))
    index = buffer.indexOf("\n")
  }
})

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Our own outbound request ids, and the resolvers waiting on their answers. */
let nextId = 1000
const pending = new Map()

function request(method, params) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    send({ jsonrpc: "2.0", id, method, params })
  })
}

function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    pending.get(message.id)?.(message.result)
    pending.delete(message.id)
    return
  }
  const { id, method, params } = message
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "stub" },
        agentCapabilities: {
          ...(images ? { promptCapabilities: { image: true } } : null),
          sessionCapabilities: {},
        },
      },
    })
    return
  }
  if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "stub-session", configOptions: [] } })
    return
  }
  if (method === "session/prompt") {
    void runTurn(id, params)
    return
  }
  send({ jsonrpc: "2.0", id: id ?? null, result: null })
}

async function runTurn(id, params) {
  // The tool call first: `session/request_permission` carries only an id, so
  // the client's label has to come from here — same as a real agent.
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "stub-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "write_file",
        kind: "edit",
        status: "pending",
        rawInput: { path: "hello.txt", content: "hi" },
      },
    },
  })

  const outcome = await request("session/request_permission", {
    sessionId: "stub-session",
    toolCall: { toolCallId: "call-1" },
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-all", name: "Always allow", kind: "allow_always" },
      { optionId: "deny", name: "Reject", kind: "reject_once" },
    ],
  })

  const chosen = outcome?.outcome?.optionId ?? outcome?.outcome?.outcome ?? "none"
  // The prompt's own blocks are echoed so a test can assert what was sent.
  const blocks = (params?.prompt ?? [])
    .map((block) => (block.type === "image" ? `image:${block.mimeType}` : block.type))
    .join(",")
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "stub-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `permission=${chosen} prompt=${blocks}` },
      },
    },
  })
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } })
}
