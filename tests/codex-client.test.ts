import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { test } from "node:test"

import { CodexClient } from "@/lib/codex-client"

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    exitCode: number | null
    kill(): boolean
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.kill = () => { child.exitCode = 0; child.emit("close", 0); return true }
  return child
}

test("Codex client performs the handshake and routes responses and notifications", async () => {
  const child = fakeChild()
  const sent: string[] = []
  child.stdin.setEncoding("utf8")
  child.stdin.on("data", (chunk: string) => sent.push(chunk))
  const client = new CodexClient(child as never)
  const initialized = client.initialize()
  await new Promise((resolve) => setImmediate(resolve))
  const request = JSON.parse(sent.join("").trim()) as { id: number; method: string }
  assert.equal(request.method, "initialize")
  child.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "codex" } })}\n`)
  await initialized
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(sent.join(""), /"method":"initialized"/)
  child.stdout.write(`${JSON.stringify({ method: "item\/agentMessage\/delta", params: { delta: "hi" } })}\n`)
  assert.equal((await client.next())?.method, "item/agentMessage/delta")
  client.close()
})

test("Codex client rejects pending RPC and makes future reads terminal on exit", async () => {
  const child = fakeChild()
  const client = new CodexClient(child as never)
  const pending = client.request("model/list", {})
  child.stderr.write("signed out")
  child.emit("close", 1)
  await assert.rejects(pending, /signed out/)
  assert.equal(await client.next(), null)
})
