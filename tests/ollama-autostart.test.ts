import assert from "node:assert/strict"
import test from "node:test"

import {
  ensureOllama,
  isLoopbackOllamaUrl,
  resetOllamaAutostart,
} from "@/lib/providers/ollama-autostart"

test.beforeEach(() => {
  resetOllamaAutostart()
})

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
  const spawnImpl = (
    _command: string,
    _args: string[],
    options: { detached: boolean; windowsHide?: boolean }
  ) => {
    launches++
    assert.equal(options.detached, false)
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

test("does not spawn when 127.0.0.1 answers for a localhost URL", async () => {
  let launches = 0
  const probed: string[] = []
  const result = await ensureOllama("http://localhost:22336", {
    fetchImpl: async (url) => {
      probed.push(String(url))
      if (String(url).includes("127.0.0.1")) {
        return new Response("{}", { status: 200 })
      }
      throw new Error("IPv6 hang")
    },
    spawnImpl: () => {
      launches++
      return { once() {}, unref() {} }
    },
  })
  assert.equal(result, true)
  assert.equal(launches, 0)
  assert.ok(probed.some((url) => url.includes("127.0.0.1")))
  assert.equal(
    probed.some((url) => /localhost/i.test(url)),
    false
  )
})

test("a failed start is not retried, even across localhost and 127.0.0.1", async () => {
  let errorListener: (() => void) | undefined
  let launches = 0
  const down = async () => {
    throw new Error("ECONNREFUSED")
  }
  const spawnOnce = () => {
    launches++
    return {
      once(_event: "error", listener: () => void) {
        errorListener = listener
        queueMicrotask(() => errorListener?.())
      },
      unref() {},
    }
  }

  const result = await ensureOllama("http://localhost:22335", {
    fetchImpl: down,
    spawnImpl: spawnOnce,
    platform: "win32",
  })
  assert.equal(result, false)
  assert.equal(
    await ensureOllama("http://localhost:22335", {
      fetchImpl: down,
      spawnImpl: spawnOnce,
      platform: "win32",
    }),
    false
  )
  assert.equal(
    await ensureOllama("http://127.0.0.1:22335", {
      fetchImpl: down,
      spawnImpl: spawnOnce,
      platform: "win32",
    }),
    false
  )
  assert.equal(launches, 1)
})

test("POSIX still detaches ollama serve so it outlives the server process", async () => {
  let detached: boolean | undefined
  let host: string | undefined
  await ensureOllama("http://localhost:22337", {
    fetchImpl: async () => {
      throw new Error("down")
    },
    spawnImpl: (_command, _args, options) => {
      detached = options.detached
      host = options.env.OLLAMA_HOST
      return {
        once(_event: "error", listener: () => void) {
          queueMicrotask(listener)
        },
        unref() {},
      }
    },
    platform: "linux",
  })
  assert.equal(detached, true)
  assert.equal(host, "127.0.0.1:22337")
})
