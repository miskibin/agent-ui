import "server-only"

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

import { resolveCodexCommand } from "@/lib/codex-runtime"
import {
  detachedSpawnOptions,
  killProcessTree,
  trackChildProcess,
} from "@/lib/process-tree"

type RpcMessage = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }

export class CodexClient {
  readonly child: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private queue: RpcMessage[] = []
  private waiters: Array<(message: RpcMessage | null) => void> = []
  private closed = false
  private stderr = ""

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: RpcMessage
      try { message = JSON.parse(line) as RpcMessage } catch { return }
      if (typeof message.id === "number" && !message.method) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) {
          pending.reject(new Error(message.error.message ?? "Codex request failed"))
        } else {
          pending.resolve(message.result)
        }
        return
      }
      const waiter = this.waiters.shift()
      if (waiter) waiter(message)
      else this.queue.push(message)
    })
    child.stdin.on("error", () => { /* close/error reports the failure */ })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-20_000)
    })
    child.once("close", () => this.finish(new Error("Codex app-server exited")))
    child.once("error", (error) => this.finish(error))
  }

  static spawn(binPath: string, cwd: string) {
    const command = resolveCodexCommand(binPath)
    const child = spawn(command.cmd, [...command.args, "app-server"], {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...detachedSpawnOptions,
    })
    trackChildProcess(child)
    return new CodexClient(child)
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "agent_ui", title: "Agent UI", version: "0.6.0" }, capabilities: null })
    this.notify("initialized", {})
  }
  request(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} did not answer within ${timeoutMs / 1000}s`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      try { this.send({ id, method, params }) } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }
  respond(id: number | string, result: unknown) { this.send({ id, result }) }
  respondError(id: number | string, message: string) {
    this.send({ id, error: { code: -32601, message } } as RpcMessage)
  }
  notify(method: string, params?: unknown) { this.send({ method, params }) }
  async next(): Promise<RpcMessage | null> {
    const message = this.queue.shift()
    if (message) return message
    if (this.closed) return null
    return new Promise((resolve) => this.waiters.push(resolve))
  }
  close() {
    if (this.child.pid != null) killProcessTree(this.child)
    else if (this.child.exitCode == null) this.child.kill("SIGTERM")
  }
  private send(message: RpcMessage) { this.child.stdin.write(`${JSON.stringify(message)}\n`) }
  private finish(error: Error) {
    if (this.closed) return
    this.closed = true
    if (this.stderr.trim()) error = new Error(`${error.message}: ${this.stderr.trim()}`)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const waiter of this.waiters) waiter(null)
    this.waiters = []
  }
}
