import assert from "node:assert/strict"
import test from "node:test"

import {
  ensureOllama,
  isLoopbackOllamaUrl,
} from "@/lib/providers/ollama-autostart"

test("only accepts loopback HTTP Ollama URLs", () => {
  assert.equal(isLoopbackOllamaUrl("http://localhost:11434"), true)
  assert.equal(isLoopbackOllamaUrl("http://127.0.0.1:11434/"), true)
  assert.equal(isLoopbackOllamaUrl("http://[::1]:11434"), true)
  assert.equal(isLoopbackOllamaUrl("https://localhost:11434"), false)
  assert.equal(isLoopbackOllamaUrl("file:///tmp/ollama"), false)
})

test("starts Ollama once and waits until its health endpoint answers", async () => {
  let probes = 0
  let launches = 0
  const fetchImpl = async () => {
    probes++
    if (probes < 3) throw new Error("ECONNREFUSED")
    return new Response("{}", { status: 200 })
  }
  const spawnImpl = (_command: string, _args: string[], options: { windowsHide?: boolean }) => {
    launches++
    assert.equal(options.windowsHide, true)
    return { once() {}, unref() {} }
  }

  const [first, second] = await Promise.all([
    ensureOllama("http://localhost:11434", {
      fetchImpl,
      spawnImpl,
      platform: "win32",
    }),
    ensureOllama("http://localhost:11434", {
      fetchImpl,
      spawnImpl,
      platform: "win32",
    }),
  ])

  assert.equal(first, true)
  assert.equal(second, true)
  assert.equal(launches, 1)
  assert.equal(probes, 3)
})

test("does not launch for a hosted Ollama-looking URL", async () => {
  let launches = 0
  const result = await ensureOllama("https://ollama.example.com", {
    fetchImpl: async () => {
      throw new Error("should not probe")
    },
    spawnImpl: () => {
      launches++
      return { once() {}, unref() {} }
    },
  })
  assert.equal(result, false)
  assert.equal(launches, 0)
})

test("does not spawn when the configured port is already ready", async () => {
  let launches = 0
  const result = await ensureOllama("http://localhost:22334", {
    fetchImpl: async () => new Response("{}", { status: 200 }),
    spawnImpl: () => {
      launches++
      return { once() {}, unref() {} }
    },
  })
  assert.equal(result, true)
  assert.equal(launches, 0)
})

test("handles an asynchronous spawn error without an unhandled rejection", async () => {
  let errorListener: (() => void) | undefined
  let launches = 0
  const result = await ensureOllama("http://localhost:22335", {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED")
    },
    spawnImpl: () => {
      launches++
      return {
        once(_event: "error", listener: () => void) {
          errorListener = listener
          queueMicrotask(() => errorListener?.())
        },
        unref() {},
      }
    },
  })
  assert.equal(result, false)
  assert.equal(
    await ensureOllama("http://localhost:22335", {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED")
      },
      spawnImpl: () => {
        launches++
        return { once() {}, unref() {} }
      },
    }),
    false
  )
  assert.equal(launches, 1)
})
